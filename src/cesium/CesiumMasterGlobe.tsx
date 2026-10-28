import React, { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { MilitaryAsset, ConflictEvent } from '../data/osintData';
import { getOrCreateGlbModels, GlbModelDictionary } from './glbModelFactory';

// Ensure Cesium static worker/asset base URL is configured
(window as any).CESIUM_BASE_URL = '/cesium';

// User's CARTO Basemaps API Key
const CARTO_API_KEY = 'cb1_4we0_1_3fb0d9a1435ee094896ea343';

export interface GlobeViewBounds {
  lat: number;
  lon: number;
  altitudeKm: number;
  westDeg: number;
  southDeg: number;
  eastDeg: number;
  northDeg: number;
  radiusDeg: number;
}

export interface CombatEngagementLogItem {
  id: string;
  simTimeLabel: string;
  attackerCallsign: string;
  attackerAllegiance: string;
  targetCallsign: string;
  isOpeningShot: boolean;
  losStatus: string;
  terrainModifierPct: number;
  forceRatioModifierPct: number;
  hitProbabilityPct: number;
  rolledPct: number;
  outcome: 'HIT' | 'CRITICAL DESTRUCTION' | 'INTERCEPTED / MISSED';
  damageDealt: number;
  targetRemainingHp: number;
}

export interface SimUnitStatus {
  id: string;
  callsign: string;
  designation: string;
  allegiance: string;
  hp: number;
  destroyed: boolean;
  hasFiredOpeningShot: boolean;
  kills: number;
  lat: number;
  lon: number;
}

export interface LiveCombatTelemetry {
  simElapsedSec: number;
  activeThreats: number;
  activeInterceptors: number;
  midAirIntercepts: number;
  surfaceImpacts: number;
  blueAliveCount: number;
  redAliveCount: number;
  blueDestroyedCount: number;
  redDestroyedCount: number;
  lastEngagementLog: string;
  recentEngagements: CombatEngagementLogItem[];
  unitStatuses: SimUnitStatus[];
}

export type BasemapStyle = 'satellite-hybrid' | 'carto-voyager' | 'tactical-dark';

interface CesiumMasterGlobeProps {
  viewMode: 'live-osint' | 'simulation';
  assets: MilitaryAsset[];
  events: ConflictEvent[];
  selectedAssetId: string | null;
  selectedEventId: string | null;
  showRadarDomes: boolean;
  showPatrolTracks: boolean;
  basemapStyle: BasemapStyle;
  simPlaying: boolean;
  simSpeedMultiplier: number;
  interceptorEfficiencyPct: number;
  openingShotBonusPct: number;
  terrainMaskingWeight: number;
  salvoTriggerCount: number;
  simResetTriggerCount: number;
  placementModeActive: boolean;
  flyToTarget: { lat: number; lon: number; altMeters: number; timestamp: number } | null;
  onSelectAsset: (id: string) => void;
  onSelectEvent: (id: string) => void;
  onGlobeClickPlaceAsset?: (lat: number, lon: number) => void;
  onViewBoundsChange: (bounds: GlobeViewBounds) => void;
  onCombatTelemetryUpdate: (telemetry: LiveCombatTelemetry) => void;
}

interface DynamicAssetKinematics {
  baseAsset: MilitaryAsset;
  currentLat: number;
  currentLon: number;
  currentHeadingDeg: number;
  waypointIndex: number;
  // Wargame Simulation State
  hp: number;
  destroyed: boolean;
  hasFiredOpeningShot: boolean;
  cooldownSec: number;
  suppressedUntilSimSec: number;
  kills: number;
}

interface ActiveSalvoPair {
  id: string;
  corridorName: string;
  attackerId: string;
  attackerCallsign: string;
  attackerAllegiance: string;
  targetId: string;
  targetCallsign: string;
  isOpeningShot: boolean;
  losStatus: string;
  terrainModifierPct: number;
  forceRatioModifierPct: number;
  hitProbabilityPct: number;
  rolledPct: number;
  originLat: number;
  originLon: number;
  targetLat: number;
  targetLon: number;
  defenderLat: number;
  defenderLon: number;
  apogeeMeters: number;
  progress: number;
  durationSec: number;
  interceptProgressPoint: number;
  willHitTarget: boolean;
  resolved: boolean;
  threatEntity: Cesium.Entity;
  threatTrailEntity: Cesium.Entity;
  losLineEntity: Cesium.Entity;
  interceptorEntity: Cesium.Entity;
  interceptorTrailEntity: Cesium.Entity;
}

interface ActiveShockwave3D {
  id: string;
  centerCartesian: Cesium.Cartesian3;
  ageSec: number;
  maxAgeSec: number;
  maxRadiusMeters: number;
  isIntercept: boolean;
  entity: Cesium.Entity;
}

function formatDurationMmSs(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

function formatSimClock(simSeconds: number): string {
  const totalMins = Math.floor(simSeconds / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const secs = Math.floor(simSeconds % 60);
  return `+${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function isBlueAllegiance(allegiance: string): boolean {
  return allegiance === 'NATO / Coalition';
}

/**
 * Compute physical 3D ordnance sphere maximum radius (in meters) on the globe
 * scaled in accordance with the size (ordnanceYieldKg) and number (ordnanceCount) of munitions.
 */
export function computeOrdnanceSphereMaxRadiusMeters(
  ordnanceCount: number,
  ordnanceYieldKg: number
): number {
  const totalPayloadKg = Math.max(10, ordnanceCount * ordnanceYieldKg);
  const yieldScale = Math.cbrt(totalPayloadKg) * 3200;
  const barrageSpread = Math.sqrt(Math.max(1, ordnanceCount)) * 4800;
  return Math.min(95000, Math.max(14000, yieldScale + barrageSpread));
}

export const CesiumMasterGlobe: React.FC<CesiumMasterGlobeProps> = ({
  viewMode,
  assets,
  events,
  selectedAssetId,
  selectedEventId,
  showRadarDomes,
  showPatrolTracks,
  basemapStyle,
  simPlaying,
  simSpeedMultiplier,
  interceptorEfficiencyPct,
  openingShotBonusPct,
  terrainMaskingWeight,
  salvoTriggerCount,
  simResetTriggerCount,
  placementModeActive,
  flyToTarget,
  onSelectAsset,
  onSelectEvent,
  onGlobeClickPlaceAsset,
  onViewBoundsChange,
  onCombatTelemetryUpdate,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const propsRef = useRef({
    viewMode,
    assets,
    events,
    selectedAssetId,
    selectedEventId,
    showRadarDomes,
    showPatrolTracks,
    basemapStyle,
    simPlaying,
    simSpeedMultiplier,
    interceptorEfficiencyPct,
    openingShotBonusPct,
    terrainMaskingWeight,
    placementModeActive,
    flyToTarget,
    onSelectAsset,
    onSelectEvent,
    onGlobeClickPlaceAsset,
    onViewBoundsChange,
    onCombatTelemetryUpdate,
  });

  useEffect(() => {
    propsRef.current = {
      viewMode,
      assets,
      events,
      selectedAssetId,
      selectedEventId,
      showRadarDomes,
      showPatrolTracks,
      basemapStyle,
      simPlaying,
      simSpeedMultiplier,
      interceptorEfficiencyPct,
      openingShotBonusPct,
      terrainMaskingWeight,
      placementModeActive,
      flyToTarget,
      onSelectAsset,
      onSelectEvent,
      onGlobeClickPlaceAsset,
      onViewBoundsChange,
      onCombatTelemetryUpdate,
    };
  });

  const runtimeRef = useRef<{
    viewer: Cesium.Viewer | null;
    glbModels: GlbModelDictionary | null;
    kinematicsMap: Map<string, DynamicAssetKinematics>;
    eventElapsedSecMap: Map<string, number>;
    assetEntities: Map<string, Cesium.Entity>;
    domeEntities: Map<string, Cesium.Entity>;
    trackEntities: Map<string, Cesium.Entity>;
    eventEntities: Cesium.Entity[];
    activeSalvos: ActiveSalvoPair[];
    activeShockwaves: ActiveShockwave3D[];
    combatStats: LiveCombatTelemetry;
    satelliteLayer: Cesium.ImageryLayer | null;
    voyagerLayer: Cesium.ImageryLayer | null;
    tacticalDarkLayer: Cesium.ImageryLayer | null;
    labelsLayer: Cesium.ImageryLayer | null;
    spawnDynamicEngagementWave: (forceManualWave: boolean) => void;
    resetSimulationToLivePositions: () => void;
    clearSimulationProjectiles: () => void;
    rebuildEntities: () => void;
  }>({
    viewer: null,
    glbModels: null,
    kinematicsMap: new Map(),
    eventElapsedSecMap: new Map(),
    assetEntities: new Map(),
    domeEntities: new Map(),
    trackEntities: new Map(),
    eventEntities: [],
    activeSalvos: [],
    activeShockwaves: [],
    combatStats: {
      simElapsedSec: 0,
      activeThreats: 0,
      activeInterceptors: 0,
      midAirIntercepts: 0,
      surfaceImpacts: 0,
      blueAliveCount: 0,
      redAliveCount: 0,
      blueDestroyedCount: 0,
      redDestroyedCount: 0,
      lastEngagementLog: 'Simulation initialized from current ground/sea/air positions',
      recentEngagements: [],
      unitStatuses: [],
    },
    satelliteLayer: null,
    voyagerLayer: null,
    tacticalDarkLayer: null,
    labelsLayer: null,
    spawnDynamicEngagementWave: () => {},
    resetSimulationToLivePositions: () => {},
    clearSimulationProjectiles: () => {},
    rebuildEntities: () => {},
  });

  const getBallisticCartesian = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
    t: number,
    apogeeMeters: number
  ): Cesium.Cartesian3 => {
    const lat = Cesium.Math.lerp(lat1, lat2, t);
    const lon = Cesium.Math.lerp(lon1, lon2, t);
    const alt = Math.sin(t * Math.PI) * apogeeMeters + 150;
    return Cesium.Cartesian3.fromDegrees(lon, lat, alt);
  };

  const getVelocityOrientation = (
    p1: Cesium.Cartesian3,
    p2: Cesium.Cartesian3,
    lon: number,
    lat: number,
    alt: number
  ): Cesium.Quaternion => {
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const heading = Math.atan2(dy, dx);
    const hpr = new Cesium.HeadingPitchRoll(heading, 0, 0);
    return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDestroyed = false;

    const viewer = new Cesium.Viewer(container, {
      baseLayer: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      skyAtmosphere: new Cesium.SkyAtmosphere(),
    });

    const creditContainer = viewer.cesiumWidget.creditContainer as HTMLElement;
    if (creditContainer) {
      creditContainer.style.display = 'none';
    }

    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#071120');
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#040811');
    viewer.scene.highDynamicRange = false;

    // 1. Offline Built-in NaturalEarthII Base Fallback Layer
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    )
      .then((naturalEarthProvider) => {
        if (!isDestroyed && !viewer.isDestroyed()) {
          const base = viewer.imageryLayers.addImageryProvider(naturalEarthProvider, 0);
          base.alpha = 1.0;
        }
      })
      .catch(() => {});

    // 2. Esri World Imagery High-Resolution Satellite Layer
    const esriSatelliteProvider = new Cesium.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 18,
    });
    const satelliteLayer = viewer.imageryLayers.addImageryProvider(esriSatelliteProvider);
    satelliteLayer.brightness = 0.88;
    satelliteLayer.contrast = 1.12;
    satelliteLayer.saturation = 0.85;

    // 3. CARTO Voyager Raster Basemap (authenticated with user's CARTO API Key)
    const cartoVoyagerProvider = new Cesium.UrlTemplateImageryProvider({
      url: `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_API_KEY}`,
      maximumLevel: 18,
    });
    const voyagerLayer = viewer.imageryLayers.addImageryProvider(cartoVoyagerProvider);
    voyagerLayer.show = propsRef.current.basemapStyle === 'carto-voyager';

    // 4. CARTO Dark Matter Tactical Basemap (authenticated with user's CARTO API Key)
    const cartoDarkProvider = new Cesium.UrlTemplateImageryProvider({
      url: `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=${CARTO_API_KEY}`,
      maximumLevel: 18,
    });
    const tacticalDarkLayer = viewer.imageryLayers.addImageryProvider(cartoDarkProvider);
    tacticalDarkLayer.show = propsRef.current.basemapStyle === 'tactical-dark';

    // 5. CARTO High-DPI Geopolitical Borders & Labels Overlay (authenticated with user's CARTO API Key)
    const cartoLabelsProvider = new Cesium.UrlTemplateImageryProvider({
      url: `https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png?key=${CARTO_API_KEY}`,
      maximumLevel: 18,
    });
    const labelsLayer = viewer.imageryLayers.addImageryProvider(cartoLabelsProvider);
    labelsLayer.alpha = 0.94;
    labelsLayer.show = propsRef.current.basemapStyle === 'satellite-hybrid';

    runtimeRef.current.viewer = viewer;
    runtimeRef.current.satelliteLayer = satelliteLayer;
    runtimeRef.current.voyagerLayer = voyagerLayer;
    runtimeRef.current.tacticalDarkLayer = tacticalDarkLayer;
    runtimeRef.current.labelsLayer = labelsLayer;

    // Initial Camera View over EMEA / Black Sea / Red Sea (or pending flyToTarget)
    const initialFly = propsRef.current.flyToTarget;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        initialFly ? initialFly.lon : 34.5,
        initialFly ? initialFly.lat : 31.5,
        initialFly ? initialFly.altMeters : 5200000
      ),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });

    // Click handler for either:
    // (a) Deploying a new 3D asset directly onto the globe in Simulation Placement Mode, OR
    // (b) Selecting 3D military models or ordnance strike spheres
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      if (
        propsRef.current.viewMode === 'simulation' &&
        propsRef.current.placementModeActive &&
        propsRef.current.onGlobeClickPlaceAsset
      ) {
        const cartesian = viewer.camera.pickEllipsoid(
          movement.position,
          viewer.scene.globe.ellipsoid
        );
        if (cartesian) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          const lat = Cesium.Math.toDegrees(carto.latitude);
          const lon = Cesium.Math.toDegrees(carto.longitude);
          propsRef.current.onGlobeClickPlaceAsset(lat, lon);
          return;
        }
      }

      const picked = viewer.scene.pick(movement.position);
      if (Cesium.defined(picked) && picked.id instanceof Cesium.Entity) {
        const entityId = String(picked.id.id);
        if (entityId.startsWith('ASSET::') || entityId.startsWith('DOME::')) {
          const rawId = entityId.split('::')[1];
          propsRef.current.onSelectAsset(rawId);
        } else if (entityId.startsWith('EVENT::')) {
          const rawId = entityId.split('::')[1];
          propsRef.current.onSelectEvent(rawId);
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    const clearSimulationProjectiles = () => {
      const v = runtimeRef.current.viewer;
      if (!v || v.isDestroyed()) return;
      runtimeRef.current.activeSalvos.forEach((s) => {
        v.entities.remove(s.threatEntity);
        v.entities.remove(s.threatTrailEntity);
        v.entities.remove(s.losLineEntity);
        v.entities.remove(s.interceptorEntity);
        v.entities.remove(s.interceptorTrailEntity);
      });
      runtimeRef.current.activeSalvos = [];
      runtimeRef.current.activeShockwaves.forEach((w) => {
        v.entities.remove(w.entity);
      });
      runtimeRef.current.activeShockwaves = [];
    };

    runtimeRef.current.clearSimulationProjectiles = clearSimulationProjectiles;

    const resetSimulationToLivePositions = () => {
      clearSimulationProjectiles();
      runtimeRef.current.combatStats = {
        simElapsedSec: 0,
        activeThreats: 0,
        activeInterceptors: 0,
        midAirIntercepts: 0,
        surfaceImpacts: 0,
        blueAliveCount: 0,
        redAliveCount: 0,
        blueDestroyedCount: 0,
        redDestroyedCount: 0,
        lastEngagementLog:
          'Simulation reset to current live OSINT positions — all units 100% integrity & Opening Shot ready',
        recentEngagements: [],
        unitStatuses: [],
      };
      runtimeRef.current.kinematicsMap.forEach((kin) => {
        kin.currentLat = kin.baseAsset.lat;
        kin.currentLon = kin.baseAsset.lon;
        kin.currentHeadingDeg = kin.baseAsset.headingDeg;
        kin.waypointIndex = 0;
        kin.hp = 100;
        kin.destroyed = false;
        kin.hasFiredOpeningShot = false;
        kin.cooldownSec = Math.random() * 1.5;
        kin.suppressedUntilSimSec = 0;
        kin.kills = 0;
      });
      propsRef.current.onCombatTelemetryUpdate({ ...runtimeRef.current.combatStats });
    };

    runtimeRef.current.resetSimulationToLivePositions = resetSimulationToLivePositions;

    // Build all Assets (Last Reported Locations in live-osint mode; Dynamic Combat Units in simulation mode)
    const rebuildEntities = () => {
      const v = runtimeRef.current.viewer;
      const glbDict = runtimeRef.current.glbModels;
      if (!v || v.isDestroyed()) return;

      const {
        viewMode: curMode,
        assets: curAssets,
        events: curEvents,
        selectedAssetId: selAssetId,
        selectedEventId: selEventId,
        showRadarDomes: domesVisible,
        showPatrolTracks: tracksVisible,
      } = propsRef.current;

      // Clear existing entities
      runtimeRef.current.assetEntities.forEach((e) => v.entities.remove(e));
      runtimeRef.current.domeEntities.forEach((e) => v.entities.remove(e));
      runtimeRef.current.trackEntities.forEach((e) => v.entities.remove(e));
      runtimeRef.current.eventEntities.forEach((e) => v.entities.remove(e));

      runtimeRef.current.assetEntities.clear();
      runtimeRef.current.domeEntities.clear();
      runtimeRef.current.trackEntities.clear();
      runtimeRef.current.eventEntities = [];

      // Sync asset positions & simulation combat state
      for (const asset of curAssets) {
        if (!runtimeRef.current.kinematicsMap.has(asset.id)) {
          runtimeRef.current.kinematicsMap.set(asset.id, {
            baseAsset: asset,
            currentLat: asset.lat,
            currentLon: asset.lon,
            currentHeadingDeg: asset.headingDeg,
            waypointIndex: 0,
            hp: 100,
            destroyed: false,
            hasFiredOpeningShot: false,
            cooldownSec: Math.random() * 1.2,
            suppressedUntilSimSec: 0,
            kills: 0,
          });
        } else {
          const existing = runtimeRef.current.kinematicsMap.get(asset.id)!;
          existing.baseAsset = asset;
          if (curMode === 'live-osint') {
            existing.currentLat = asset.lat;
            existing.currentLon = asset.lon;
            existing.currentHeadingDeg = asset.headingDeg;
          }
        }
      }

      // 1. Render Military Assets
      for (const asset of curAssets) {
        const isSelected = selAssetId === asset.id && !selEventId;
        const allegianceColor =
          asset.allegiance === 'NATO / Coalition'
            ? Cesium.Color.fromCssColorString('#38bdf8')
            : asset.allegiance === 'Russian Federation'
            ? Cesium.Color.fromCssColorString('#ef4444')
            : asset.allegiance === 'PLA / China'
            ? Cesium.Color.fromCssColorString('#f59e0b')
            : Cesium.Color.fromCssColorString('#a855f7');

        const displayAlt =
          asset.domain === 'Airspace'
            ? Math.max(4500, asset.altitudeMeters * 2.2)
            : asset.domain === 'Subsurface'
            ? 80
            : 120;

        const posProperty =
          curMode === 'simulation'
            ? (new Cesium.CallbackProperty(() => {
                const kin = runtimeRef.current.kinematicsMap.get(asset.id);
                const lat = kin ? kin.currentLat : asset.lat;
                const lon = kin ? kin.currentLon : asset.lon;
                return Cesium.Cartesian3.fromDegrees(lon, lat, displayAlt);
              }, false) as unknown as Cesium.PositionProperty)
            : Cesium.Cartesian3.fromDegrees(asset.lon, asset.lat, displayAlt);

        const orientProperty =
          curMode === 'simulation'
            ? (new Cesium.CallbackProperty(() => {
                const kin = runtimeRef.current.kinematicsMap.get(asset.id);
                const lat = kin ? kin.currentLat : asset.lat;
                const lon = kin ? kin.currentLon : asset.lon;
                const hdg = kin ? kin.currentHeadingDeg : asset.headingDeg;
                const pos = Cesium.Cartesian3.fromDegrees(lon, lat, displayAlt);
                const hpr = new Cesium.HeadingPitchRoll(
                  Cesium.Math.toRadians(hdg - 90),
                  0,
                  0
                );
                return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
              }, false) as unknown as Cesium.Property)
            : Cesium.Transforms.headingPitchRollQuaternion(
                Cesium.Cartesian3.fromDegrees(asset.lon, asset.lat, displayAlt),
                new Cesium.HeadingPitchRoll(
                  Cesium.Math.toRadians(asset.headingDeg - 90),
                  0,
                  0
                )
              );

        const modelUri = glbDict ? glbDict[asset.modelType] : undefined;

        const labelTextProperty =
          curMode === 'simulation'
            ? (new Cesium.CallbackProperty(() => {
                const kin = runtimeRef.current.kinematicsMap.get(asset.id);
                if (!kin) return `${asset.callsign}\nSIM READY`;
                if (kin.destroyed) {
                  return `${asset.callsign} [DESTROYED]\n0% Integrity · Out of Action`;
                }
                const initTag = !kin.hasFiredOpeningShot ? 'OPENING SHOT ARMED' : 'ENGAGED';
                const killsTag = kin.kills > 0 ? ` · ${kin.kills}x KILLS` : '';
                return `${asset.callsign} [HP ${Math.round(kin.hp)}%]\n${initTag}${killsTag}`;
              }, false) as unknown as string)
            : `${asset.callsign}\n${
                asset.isLiveTransponder
                  ? `LIVE ADS-B · ${asset.speedKnots} kts`
                  : `LAST REPORTED: ${asset.lastReportedUtc.replace('2026-10-27 ', '')}`
              }`;

        const entity = v.entities.add({
          id: `ASSET::${asset.id}`,
          name: asset.designation,
          position: posProperty,
          orientation: orientProperty,
          model: modelUri
            ? {
                uri: modelUri,
                minimumPixelSize: isSelected ? 76 : 54,
                maximumScale: 32000,
                silhouetteColor: isSelected ? Cesium.Color.WHITE : allegianceColor,
                silhouetteSize: isSelected ? 3.0 : 1.4,
                colorBlendMode: Cesium.ColorBlendMode.MIX,
                color:
                  curMode === 'simulation'
                    ? (new Cesium.CallbackProperty(() => {
                        const kin = runtimeRef.current.kinematicsMap.get(asset.id);
                        if (kin && kin.destroyed) {
                          return Cesium.Color.fromCssColorString('#334155');
                        }
                        return allegianceColor;
                      }, false) as unknown as Cesium.Color)
                    : allegianceColor,
                colorBlendAmount: isSelected ? 0.15 : 0.32,
              }
            : undefined,
          point: {
            pixelSize: isSelected ? 11 : 7,
            color: allegianceColor,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: labelTextProperty,
            font: '600 11px "IBM Plex Mono", monospace',
            fillColor: isSelected
              ? Cesium.Color.fromCssColorString('#ffffff')
              : Cesium.Color.fromCssColorString('#e2e8f0'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor:
              curMode === 'simulation'
                ? (new Cesium.CallbackProperty(() => {
                    const kin = runtimeRef.current.kinematicsMap.get(asset.id);
                    if (kin && kin.destroyed) {
                      return Cesium.Color.fromCssColorString('rgba(69, 10, 10, 0.88)');
                    }
                    return isSelected
                      ? Cesium.Color.fromCssColorString('rgba(2, 132, 199, 0.88)')
                      : Cesium.Color.fromCssColorString('rgba(15, 23, 42, 0.84)');
                  }, false) as unknown as Cesium.Color)
                : isSelected
                ? Cesium.Color.fromCssColorString('rgba(2, 132, 199, 0.88)')
                : Cesium.Color.fromCssColorString('rgba(15, 23, 42, 0.84)'),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            pixelOffset: new Cesium.Cartesian2(0, -34),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(300000, 1.0, 12000000, 0.72),
          },
        });
        runtimeRef.current.assetEntities.set(asset.id, entity);

        // 2. 3D Radar / Strike Reach Dome
        if (domesVisible) {
          const radiusMeters = Math.min(800000, asset.combatRadiusKm * 1000);
          const domeEntity = v.entities.add({
            id: `DOME::${asset.id}`,
            position: posProperty,
            ellipsoid: {
              radii: new Cesium.Cartesian3(radiusMeters, radiusMeters, radiusMeters * 0.3),
              maximumCone: Cesium.Math.PI_OVER_TWO,
              material: allegianceColor.withAlpha(isSelected ? 0.14 : 0.05),
              outline: true,
              outlineColor: allegianceColor.withAlpha(isSelected ? 0.8 : 0.32),
              slicePartitions: 24,
              stackPartitions: 12,
            },
          });
          runtimeRef.current.domeEntities.set(asset.id, domeEntity);
        }

        // 3. Patrol Waypoints (Only shown in Simulation mode when toggled)
        if (
          tracksVisible &&
          curMode === 'simulation' &&
          asset.patrolWaypoints &&
          asset.patrolWaypoints.length > 1
        ) {
          const coords: number[] = [];
          asset.patrolWaypoints.forEach(([wLat, wLon]) => {
            coords.push(wLon, wLat, displayAlt);
          });
          coords.push(
            asset.patrolWaypoints[0][1],
            asset.patrolWaypoints[0][0],
            displayAlt
          );

          const trackEntity = v.entities.add({
            id: `TRACK::${asset.id}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(coords),
              width: isSelected ? 2.5 : 1.5,
              material: new Cesium.PolylineDashMaterialProperty({
                color: allegianceColor.withAlpha(isSelected ? 0.9 : 0.55),
                dashLength: 16,
              }),
            },
          });
          runtimeRef.current.trackEntities.set(asset.id, trackEntity);
        }
      }

      // 4. Render Ordnance Strike Events as Slow-Expanding 3D Spheres (10 to 15 Minutes)
      for (const evt of curEvents) {
        if (!runtimeRef.current.eventElapsedSecMap.has(evt.id)) {
          runtimeRef.current.eventElapsedSecMap.set(evt.id, evt.initialElapsedSeconds || 60);
        }

        const isSelected = selEventId === evt.id;
        const totalDurationSec = Math.max(600, (evt.dissipationMinutes || 12) * 60);
        const maxRadiusMeters = computeOrdnanceSphereMaxRadiusMeters(
          evt.ordnanceCount,
          evt.ordnanceYieldKg
        );
        const totalHeKg = evt.ordnanceCount * evt.ordnanceYieldKg;

        const baseColor =
          evt.severityLevel === 'Critical'
            ? Cesium.Color.fromCssColorString('#ef4444')
            : evt.severityLevel === 'High'
            ? Cesium.Color.fromCssColorString('#f97316')
            : Cesium.Color.fromCssColorString('#eab308');

        const primarySphere = v.entities.add({
          id: `EVENT::${evt.id}`,
          position: Cesium.Cartesian3.fromDegrees(evt.lon, evt.lat, 0),
          ellipsoid: {
            radii: new Cesium.CallbackProperty(() => {
              const elapsed = runtimeRef.current.eventElapsedSecMap.get(evt.id) || 0;
              const progress = Math.min(1.0, elapsed / totalDurationSec);
              const eased = 0.18 + 0.82 * Math.pow(progress, 0.65);
              const r = Math.max(4000, maxRadiusMeters * eased);
              return new Cesium.Cartesian3(r, r, r * 0.62);
            }, false),
            maximumCone: Cesium.Math.PI_OVER_TWO,
            material: new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(() => {
                const elapsed = runtimeRef.current.eventElapsedSecMap.get(evt.id) || 0;
                const progress = Math.min(1.0, elapsed / totalDurationSec);
                const alpha = isSelected
                  ? Math.max(0.24, 0.58 - progress * 0.32)
                  : Math.max(0.14, 0.44 - progress * 0.28);
                return baseColor.withAlpha(alpha);
              }, false)
            ),
            outline: true,
            outlineColor: isSelected ? Cesium.Color.WHITE : baseColor.withAlpha(0.9),
            slicePartitions: 28,
            stackPartitions: 14,
          },
          point: {
            pixelSize: isSelected ? 12 : 9,
            color: Cesium.Color.fromCssColorString('#fef08a'),
            outlineColor: baseColor,
            outlineWidth: 3,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: new Cesium.CallbackProperty(() => {
              const elapsed = runtimeRef.current.eventElapsedSecMap.get(evt.id) || 0;
              const clamped = Math.min(totalDurationSec, elapsed);
              return `${evt.id} · ${evt.ordnanceCount}x ${evt.ordnanceType.split(' ')[0]} (${totalHeKg.toLocaleString()} kg HE)\nOrdnance Sphere: ${formatDurationMmSs(clamped)} / ${evt.dissipationMinutes}m 00s`;
            }, false) as unknown as string,
            font: '600 11px "IBM Plex Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: isSelected
              ? Cesium.Color.fromCssColorString('rgba(220, 38, 38, 0.92)')
              : Cesium.Color.fromCssColorString('rgba(127, 29, 29, 0.86)'),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            pixelOffset: new Cesium.Cartesian2(0, -32),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(300000, 1.0, 12000000, 0.72),
          },
        });
        runtimeRef.current.eventEntities.push(primarySphere);

        const subCount = Math.min(6, Math.max(0, evt.ordnanceCount - 1));
        const singleSubMaxRadius = Math.max(
          5500,
          Math.cbrt(Math.max(25, evt.ordnanceYieldKg)) * 2200
        );

        for (let s = 0; s < subCount; s++) {
          const angle = (s / subCount) * Math.PI * 2 + 0.4;
          const offsetDeg = 0.08 + (s % 2) * 0.05;
          const subLat = evt.lat + Math.cos(angle) * offsetDeg * 0.7;
          const subLon = evt.lon + Math.sin(angle) * offsetDeg;

          const subSphere = v.entities.add({
            id: `EVENT::${evt.id}::SUB::${s}`,
            position: Cesium.Cartesian3.fromDegrees(subLon, subLat, 0),
            ellipsoid: {
              radii: new Cesium.CallbackProperty(() => {
                const elapsed = runtimeRef.current.eventElapsedSecMap.get(evt.id) || 0;
                const progress = Math.min(1.0, elapsed / totalDurationSec);
                const eased = 0.2 + 0.8 * Math.pow(progress, 0.65);
                const r = singleSubMaxRadius * eased;
                return new Cesium.Cartesian3(r, r, r * 0.58);
              }, false),
              maximumCone: Cesium.Math.PI_OVER_TWO,
              material: baseColor.withAlpha(0.22),
              outline: true,
              outlineColor: baseColor.withAlpha(0.65),
              slicePartitions: 16,
              stackPartitions: 8,
            },
          });
          runtimeRef.current.eventEntities.push(subSphere);
        }
      }
    };

    runtimeRef.current.rebuildEntities = rebuildEntities;

    /**
     * Dynamic Asset-vs-Asset Wargame Engagement Spawner (Tab 2: Simulation ONLY)
     * Evaluates:
     * 1. Current positions on the ground/sea/air (`kin.currentLat`, `kin.currentLon`)
     * 2. Who targets first (Initiative + AWACS Link + Opening Shot Bonus)
     * 3. Terrain & Line-of-Sight (Radar Horizon $4.12(\sqrt{h_1} + \sqrt{h_2})$ + Target Terrain Masking)
     * 4. Number of Assets in Sector (Force Ratio / Salvo Saturation Bonus)
     * 5. Random Percentage Roll to Hit (`1–100%`)
     */
    const spawnDynamicEngagementWave = (forceManualWave: boolean) => {
      if (propsRef.current.viewMode !== 'simulation') return;
      const v = runtimeRef.current.viewer;
      const glbDict = runtimeRef.current.glbModels;
      if (!v || v.isDestroyed()) return;

      const allUnits = Array.from(runtimeRef.current.kinematicsMap.values()).filter(
        (u) => !u.destroyed && u.hp > 0
      );
      const blueUnits = allUnits.filter((u) => isBlueAllegiance(u.baseAsset.allegiance));
      const redUnits = allUnits.filter((u) => !isBlueAllegiance(u.baseAsset.allegiance));

      if (blueUnits.length === 0 || redUnits.length === 0) return;

      // Sort potential attackers by First-Strike Initiative (so higher-initiative units fire first!)
      const candidates = [...allUnits].sort((a, b) => {
        const initA =
          (a.baseAsset.firstStrikeInitiative || 75) + (!a.hasFiredOpeningShot ? 25 : 0);
        const initB =
          (b.baseAsset.firstStrikeInitiative || 75) + (!b.hasFiredOpeningShot ? 25 : 0);
        return initB - initA;
      });

      let spawnedCount = 0;
      const maxPerWave = forceManualWave ? 4 : 2;
      const curSimSec = runtimeRef.current.combatStats.simElapsedSec;

      for (const attacker of candidates) {
        if (spawnedCount >= maxPerWave) break;
        if (!forceManualWave && attacker.cooldownSec > 0) continue;

        const isAttackerBlue = isBlueAllegiance(attacker.baseAsset.allegiance);
        const enemies = isAttackerBlue ? redUnits : blueUnits;
        const friendlies = isAttackerBlue ? blueUnits : redUnits;

        // Find nearest surviving enemy within extended engagement reach
        let nearestEnemy: DynamicAssetKinematics | null = null;
        let minDistKm = Infinity;

        for (const enemy of enemies) {
          if (enemy.destroyed || enemy.hp <= 0) continue;
          const distKm = haversineDistanceKm(
            attacker.currentLat,
            attacker.currentLon,
            enemy.currentLat,
            enemy.currentLon
          );
          const maxReachKm = Math.max(650, attacker.baseAsset.combatRadiusKm * 1.65);
          if (distKm <= maxReachKm && distKm < minDistKm) {
            minDistKm = distKm;
            nearestEnemy = enemy;
          }
        }

        if (!nearestEnemy) continue;

        // Check if attacker has an allied AWACS within 900km for Over-The-Horizon (OTH) Line of Sight
        const hasAwacsLink = friendlies.some(
          (f) =>
            !f.destroyed &&
            f.baseAsset.modelType === 'awacs' &&
            haversineDistanceKm(
              attacker.currentLat,
              attacker.currentLon,
              f.currentLat,
              f.currentLon
            ) <= 950
        );

        // 1. Line of Sight (LOS) & Radar Horizon Calculation
        const attAltM =
          attacker.baseAsset.domain === 'Airspace'
            ? Math.max(8000, attacker.baseAsset.altitudeMeters)
            : 45;
        const tgtAltM =
          nearestEnemy.baseAsset.domain === 'Airspace'
            ? Math.max(8000, nearestEnemy.baseAsset.altitudeMeters)
            : 35;
        const radarHorizonKm = 4.12 * (Math.sqrt(attAltM) + Math.sqrt(tgtAltM));

        let losStatus = 'Clear Direct LOS';
        let losMod = 10;
        if (minDistKm <= radarHorizonKm) {
          losStatus = 'Clear Direct LOS';
          losMod = 12;
        } else if (hasAwacsLink) {
          losStatus = 'AWACS Datalink OTH LOS';
          losMod = 14;
        } else {
          losStatus = 'Beyond Horizon / Curvature Masked';
          losMod = -14;
        }

        // 2. Target Terrain Cover Modifier (weighted by user's Terrain Masking slider)
        const terrainScale = (propsRef.current.terrainMaskingWeight || 100) / 100;
        const tgtCover = nearestEnemy.baseAsset.terrainCover || 'Open Sea / Airspace';
        let rawTerrainMod = 0;
        if (tgtCover === 'Highland / Mountain Masking') rawTerrainMod = -18;
        else if (tgtCover === 'Urban / Fortified Defilade') rawTerrainMod = -12;
        else if (tgtCover === 'Coastal / Littoral Clutter') rawTerrainMod = -6;
        else rawTerrainMod = 8; // Open Sea / Airspace

        const terrainModifierPct = Math.round(rawTerrainMod * terrainScale + losMod);

        // 3. Number of Assets in Sector (Force Ratio / Salvo Saturation)
        const sectorFriendlies = friendlies.filter(
          (f) =>
            !f.destroyed &&
            haversineDistanceKm(
              f.currentLat,
              f.currentLon,
              nearestEnemy!.currentLat,
              nearestEnemy!.currentLon
            ) <= 950
        ).length;
        const sectorEnemies = enemies.filter(
          (e) =>
            !e.destroyed &&
            haversineDistanceKm(
              e.currentLat,
              e.currentLon,
              nearestEnemy!.currentLat,
              nearestEnemy!.currentLon
            ) <= 950
        ).length;
        const forceDiff = sectorFriendlies - sectorEnemies;
        const forceRatioModifierPct = Math.max(-15, Math.min(24, forceDiff * 6));

        // 4. Opening Shot Advantage (Who Targets First)
        const isOpeningShot = !attacker.hasFiredOpeningShot;
        const openingBonus = isOpeningShot ? propsRef.current.openingShotBonusPct : 0;

        // 5. Suppression Penalty (if attacker was recently hit by an enemy Opening Shot)
        const isSuppressed = curSimSec < attacker.suppressedUntilSimSec;
        const suppressionPenalty = isSuppressed ? -18 : 0;

        // 6. Target Point-Defense / Interceptor Efficiency
        const baseHit = attacker.baseAsset.baseHitProbabilityPct || 72;
        const defensePenalty = Math.round((propsRef.current.interceptorEfficiencyPct - 70) * 0.35);

        const hitProbabilityPct = Math.max(
          12,
          Math.min(
            95,
            Math.round(
              baseHit +
                openingBonus +
                terrainModifierPct +
                forceRatioModifierPct +
                suppressionPenalty -
                defensePenalty
            )
          )
        );

        const rolledPct = Math.floor(Math.random() * 100) + 1;
        const willHitTarget = rolledPct <= hitProbabilityPct;

        attacker.hasFiredOpeningShot = true;
        attacker.cooldownSec = 4.5 + Math.random() * 2.5;

        const oLat = attacker.currentLat;
        const oLon = attacker.currentLon;
        const tLat = nearestEnemy.currentLat;
        const tLon = nearestEnemy.currentLon;
        const apogeeMeters = Math.min(165000, Math.max(38000, minDistKm * 150));
        const interceptT = 0.66 + Math.random() * 0.1;

        let salvoRef: ActiveSalvoPair | null = null;

        const threatPosCallback = new Cesium.CallbackProperty(() => {
          const p = salvoRef ? salvoRef.progress : 0;
          return getBallisticCartesian(oLat, oLon, tLat, tLon, p, apogeeMeters);
        }, false);

        const threatOrientCallback = new Cesium.CallbackProperty(() => {
          const p = salvoRef ? salvoRef.progress : 0;
          const pNext = Math.min(1, p + 0.02);
          const pos1 = getBallisticCartesian(oLat, oLon, tLat, tLon, p, apogeeMeters);
          const pos2 = getBallisticCartesian(oLat, oLon, tLat, tLon, pNext, apogeeMeters);
          const curLat = Cesium.Math.lerp(oLat, tLat, p);
          const curLon = Cesium.Math.lerp(oLon, tLon, p);
          const curAlt = Math.sin(p * Math.PI) * apogeeMeters + 150;
          return getVelocityOrientation(pos1, pos2, curLon, curLat, curAlt);
        }, false);

        const threatTrailCallback = new Cesium.CallbackProperty(() => {
          const maxP = salvoRef ? salvoRef.progress : 0.02;
          const pts: Cesium.Cartesian3[] = [];
          const steps = 16;
          for (let s = 0; s <= steps; s++) {
            const frac = (s / steps) * maxP;
            pts.push(getBallisticCartesian(oLat, oLon, tLat, tLon, frac, apogeeMeters));
          }
          return pts;
        }, false);

        // 3D Line-of-Sight (LOS) Vector between Attacker and Target
        const losColor =
          losMod > 0
            ? Cesium.Color.fromCssColorString('#22c55e').withAlpha(0.55)
            : Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.55);

        const losLineEntity = v.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
              oLon,
              oLat,
              attAltM,
              tLon,
              tLat,
              tgtAltM,
            ]),
            width: 1.5,
            material: new Cesium.PolylineDashMaterialProperty({
              color: losColor,
              dashLength: 12,
            }),
          },
        });

        const interceptCartesian = getBallisticCartesian(
          oLat,
          oLon,
          tLat,
          tLon,
          interceptT,
          apogeeMeters
        );
        const interceptCarto = Cesium.Cartographic.fromCartesian(interceptCartesian);
        const intTargetLat = Cesium.Math.toDegrees(interceptCarto.latitude);
        const intTargetLon = Cesium.Math.toDegrees(interceptCarto.longitude);
        const intTargetAlt = interceptCarto.height;

        const getInterceptorPoint = (prog: number): Cesium.Cartesian3 => {
          const normT = Math.min(1, prog / interceptT);
          const lat = Cesium.Math.lerp(tLat, intTargetLat, normT);
          const lon = Cesium.Math.lerp(tLon, intTargetLon, normT);
          const alt = Cesium.Math.lerp(150, intTargetAlt, normT);
          return Cesium.Cartesian3.fromDegrees(lon, lat, alt);
        };

        const intPosCallback = new Cesium.CallbackProperty(() => {
          const p = salvoRef ? salvoRef.progress : 0;
          return getInterceptorPoint(p);
        }, false);

        const intTrailCallback = new Cesium.CallbackProperty(() => {
          const maxP = salvoRef ? salvoRef.progress : 0.02;
          return [
            Cesium.Cartesian3.fromDegrees(tLon, tLat, 150),
            getInterceptorPoint(maxP),
          ];
        }, false);

        const salvoColor = isAttackerBlue
          ? Cesium.Color.fromCssColorString('#38bdf8')
          : Cesium.Color.fromCssColorString('#f97316');

        const threatEntity = v.entities.add({
          position: threatPosCallback as unknown as Cesium.PositionProperty,
          orientation: threatOrientCallback as unknown as Cesium.Property,
          model: glbDict
            ? {
                uri: glbDict.missile,
                minimumPixelSize: 44,
                maximumScale: 24000,
                color: salvoColor,
                silhouetteColor: Cesium.Color.WHITE,
                silhouetteSize: 2.0,
              }
            : undefined,
          point: {
            pixelSize: 9,
            color: salvoColor,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
          },
        });

        const threatTrailEntity = v.entities.add({
          polyline: {
            positions: threatTrailCallback as unknown as Cesium.PositionProperty,
            width: 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: salvoColor,
            }),
          },
        });

        const interceptorEntity = v.entities.add({
          position: intPosCallback as unknown as Cesium.PositionProperty,
          model: glbDict
            ? {
                uri: glbDict.interceptor,
                minimumPixelSize: 38,
                maximumScale: 20000,
                color: Cesium.Color.fromCssColorString('#10b981'),
                silhouetteColor: Cesium.Color.WHITE,
                silhouetteSize: 1.5,
              }
            : undefined,
          point: {
            pixelSize: 7,
            color: Cesium.Color.fromCssColorString('#10b981'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
          },
        });

        const interceptorTrailEntity = v.entities.add({
          polyline: {
            positions: intTrailCallback as unknown as Cesium.PositionProperty,
            width: 2,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: Cesium.Color.fromCssColorString('#10b981'),
            }),
          },
        });

        salvoRef = {
          id: `SALVO-${Date.now()}-${spawnedCount}`,
          corridorName: `${attacker.baseAsset.callsign} → ${nearestEnemy.baseAsset.callsign}`,
          attackerId: attacker.baseAsset.id,
          attackerCallsign: attacker.baseAsset.callsign,
          attackerAllegiance: attacker.baseAsset.allegiance,
          targetId: nearestEnemy.baseAsset.id,
          targetCallsign: nearestEnemy.baseAsset.callsign,
          isOpeningShot,
          losStatus,
          terrainModifierPct,
          forceRatioModifierPct,
          hitProbabilityPct,
          rolledPct,
          originLat: oLat,
          originLon: oLon,
          targetLat: tLat,
          targetLon: tLon,
          defenderLat: tLat,
          defenderLon: tLon,
          apogeeMeters,
          progress: 0,
          durationSec: 4.8 + Math.random() * 1.4,
          interceptProgressPoint: interceptT,
          willHitTarget,
          resolved: false,
          threatEntity,
          threatTrailEntity,
          losLineEntity,
          interceptorEntity,
          interceptorTrailEntity,
        };

        runtimeRef.current.activeSalvos.push(salvoRef);
        spawnedCount++;
      }
    };

    runtimeRef.current.spawnDynamicEngagementWave = spawnDynamicEngagementWave;

    // Load glTF models and populate scene
    getOrCreateGlbModels()
      .then((dict) => {
        if (isDestroyed || viewer.isDestroyed()) return;
        runtimeRef.current.glbModels = dict;
        rebuildEntities();
      })
      .catch(() => {
        if (!isDestroyed && !viewer.isDestroyed()) {
          rebuildEntities();
        }
      });

    const spawnShockwaveSphere = (center: Cesium.Cartesian3, isIntercept: boolean) => {
      const v = runtimeRef.current.viewer;
      if (!v || v.isDestroyed()) return;

      const waveObj: ActiveShockwave3D = {
        id: `WAVE-${Date.now()}-${Math.random()}`,
        centerCartesian: center,
        ageSec: 0,
        maxAgeSec: 2.6,
        maxRadiusMeters: isIntercept ? 95000 : 145000,
        isIntercept,
        entity: null as unknown as Cesium.Entity,
      };

      const baseColor = isIntercept
        ? Cesium.Color.fromCssColorString('#10b981')
        : Cesium.Color.fromCssColorString('#ef4444');

      waveObj.entity = v.entities.add({
        position: center,
        ellipsoid: {
          radii: new Cesium.CallbackProperty(() => {
            const frac = Math.min(1, waveObj.ageSec / waveObj.maxAgeSec);
            const r = Math.max(5000, frac * waveObj.maxRadiusMeters);
            return new Cesium.Cartesian3(r, r, r);
          }, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const frac = Math.min(1, waveObj.ageSec / waveObj.maxAgeSec);
              return baseColor.withAlpha(Math.max(0.02, (1 - frac) * 0.58));
            }, false)
          ),
          outline: true,
          outlineColor: baseColor.withAlpha(0.85),
        },
      });

      runtimeRef.current.activeShockwaves.push(waveObj);
    };

    let lastTickMs = performance.now();
    let autoSalvoAccumSec = 0;
    let lastBoundsUpdateMs = 0;

    const onPreUpdate = () => {
      if (isDestroyed || viewer.isDestroyed()) return;
      const nowMs = performance.now();
      const rawDt = Math.min(0.1, (nowMs - lastTickMs) / 1000);
      lastTickMs = nowMs;

      const {
        viewMode: curMode,
        simPlaying: isPlaying,
        simSpeedMultiplier: speedMult,
      } = propsRef.current;

      // 1. Update Camera Gaze Sub-Point & View Rectangle Bounds every 180ms
      if (nowMs - lastBoundsUpdateMs > 180) {
        lastBoundsUpdateMs = nowMs;
        const camCarto = viewer.camera.positionCartographic;
        const camLat = Cesium.Math.toDegrees(camCarto.latitude);
        const camLon = Cesium.Math.toDegrees(camCarto.longitude);
        const altKm = Math.round(camCarto.height / 1000);

        const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        let westDeg = camLon - 35;
        let southDeg = Math.max(-85, camLat - 25);
        let eastDeg = camLon + 35;
        let northDeg = Math.min(85, camLat + 25);

        if (rect) {
          westDeg = Cesium.Math.toDegrees(rect.west);
          southDeg = Cesium.Math.toDegrees(rect.south);
          eastDeg = Cesium.Math.toDegrees(rect.east);
          northDeg = Cesium.Math.toDegrees(rect.north);
        }

        const radiusDeg = Math.round(Math.max(8, Math.min(75, (altKm / 12000) * 62)));

        propsRef.current.onViewBoundsChange({
          lat: camLat,
          lon: camLon,
          altitudeKm: altKm,
          westDeg,
          southDeg,
          eastDeg,
          northDeg,
          radiusDeg,
        });
      }

      // 2. Advance 10-to-15 Minute Ordnance Strike Spheres
      const timeRate = curMode === 'live-osint' ? 1.0 : isPlaying ? speedMult : 0;
      if (timeRate > 0) {
        runtimeRef.current.eventElapsedSecMap.forEach((elapsed, evtId) => {
          const evtObj = propsRef.current.events.find((e) => e.id === evtId);
          const maxSec = evtObj ? evtObj.dissipationMinutes * 60 : 900;
          if (elapsed < maxSec) {
            runtimeRef.current.eventElapsedSecMap.set(
              evtId,
              Math.min(maxSec, elapsed + rawDt * timeRate)
            );
          }
        });
      }

      // 3. ONLY Run Simulated Unit Movement & Dynamic Asset-vs-Asset Combat When in 'simulation' Tab
      if (curMode === 'simulation' && isPlaying) {
        // Advance accelerated simulation clock (e.g. 1x = 15 sim seconds per real second; 30x = 450 sim seconds per real second)
        const simTimeStep = rawDt * speedMult * 15;
        runtimeRef.current.combatStats.simElapsedSec += simTimeStep;

        runtimeRef.current.kinematicsMap.forEach((kin) => {
          if (kin.destroyed) return;
          if (kin.cooldownSec > 0) {
            kin.cooldownSec = Math.max(0, kin.cooldownSec - rawDt * Math.max(1, speedMult * 0.35));
          }

          const asset = kin.baseAsset;
          const simKnots =
            asset.speedKnots > 0
              ? asset.speedKnots
              : asset.domain === 'Airspace'
              ? 380
              : asset.domain === 'Maritime' || asset.domain === 'Subsurface'
              ? 22
              : 12;
          const degStep = (simKnots / 600) * 0.09 * Math.sqrt(speedMult) * rawDt;

          if (asset.patrolWaypoints && asset.patrolWaypoints.length > 1) {
            const nextIdx = (kin.waypointIndex + 1) % asset.patrolWaypoints.length;
            const [targetLat, targetLon] = asset.patrolWaypoints[nextIdx];
            const dLat = targetLat - kin.currentLat;
            const dLon = targetLon - kin.currentLon;
            const dist = Math.hypot(dLat, dLon);

            if (dist < 0.15) {
              kin.waypointIndex = nextIdx;
            } else {
              kin.currentLat += (dLat / dist) * degStep;
              kin.currentLon += (dLon / dist) * degStep;
              kin.currentHeadingDeg =
                (Cesium.Math.toDegrees(Math.atan2(dLon, dLat)) + 360) % 360;
            }
          }
        });

        autoSalvoAccumSec += rawDt * Math.max(1, Math.sqrt(speedMult) * 0.6);
        if (autoSalvoAccumSec > 3.2) {
          autoSalvoAccumSec = 0;
          spawnDynamicEngagementWave(false);
        }
      }

      // Step active simulation salvos & resolve random % hit rolls
      if (curMode === 'simulation') {
        const salvos = runtimeRef.current.activeSalvos;
        const stepFactor = isPlaying ? Math.max(0.6, Math.sqrt(speedMult) * 0.55) : 0;

        for (let i = salvos.length - 1; i >= 0; i--) {
          const s = salvos[i];
          s.progress += (rawDt * stepFactor) / s.durationSec;

          // Check mid-air intercept if shot missed/was intercepted (`!s.willHitTarget`)
          if (!s.resolved && s.progress >= s.interceptProgressPoint) {
            s.resolved = true;
            if (!s.willHitTarget) {
              const hitPos = getBallisticCartesian(
                s.originLat,
                s.originLon,
                s.targetLat,
                s.targetLon,
                s.interceptProgressPoint,
                s.apogeeMeters
              );
              spawnShockwaveSphere(hitPos, true);

              viewer.entities.remove(s.threatEntity);
              viewer.entities.remove(s.threatTrailEntity);
              viewer.entities.remove(s.losLineEntity);
              viewer.entities.remove(s.interceptorEntity);
              viewer.entities.remove(s.interceptorTrailEntity);
              salvos.splice(i, 1);

              const targetKin = runtimeRef.current.kinematicsMap.get(s.targetId);
              const simClockStr = formatSimClock(runtimeRef.current.combatStats.simElapsedSec);

              const logItem: CombatEngagementLogItem = {
                id: `${s.id}-INT`,
                simTimeLabel: simClockStr,
                attackerCallsign: s.attackerCallsign,
                attackerAllegiance: s.attackerAllegiance,
                targetCallsign: s.targetCallsign,
                isOpeningShot: s.isOpeningShot,
                losStatus: s.losStatus,
                terrainModifierPct: s.terrainModifierPct,
                forceRatioModifierPct: s.forceRatioModifierPct,
                hitProbabilityPct: s.hitProbabilityPct,
                rolledPct: s.rolledPct,
                outcome: 'INTERCEPTED / MISSED',
                damageDealt: 0,
                targetRemainingHp: targetKin ? Math.round(targetKin.hp) : 100,
              };

              runtimeRef.current.combatStats.midAirIntercepts += 1;
              runtimeRef.current.combatStats.lastEngagementLog = `[${simClockStr}] INTERCEPTED (${s.rolledPct}% > ${s.hitProbabilityPct}% Hit Chance): ${s.corridorName} (${s.losStatus})`;
              runtimeRef.current.combatStats.recentEngagements = [
                logItem,
                ...runtimeRef.current.combatStats.recentEngagements.slice(0, 24),
              ];
              continue;
            } else {
              // Shot penetrated interceptor screen! Remove interceptor entities as missile continues to target impact
              viewer.entities.remove(s.interceptorEntity);
              viewer.entities.remove(s.interceptorTrailEntity);
            }
          }

          if (s.progress >= 1.0) {
            const impactPos = Cesium.Cartesian3.fromDegrees(s.targetLon, s.targetLat, 200);
            spawnShockwaveSphere(impactPos, false);

            viewer.entities.remove(s.threatEntity);
            viewer.entities.remove(s.threatTrailEntity);
            viewer.entities.remove(s.losLineEntity);
            viewer.entities.remove(s.interceptorEntity);
            viewer.entities.remove(s.interceptorTrailEntity);
            salvos.splice(i, 1);

            const targetKin = runtimeRef.current.kinematicsMap.get(s.targetId);
            const attackerKin = runtimeRef.current.kinematicsMap.get(s.attackerId);
            const simClockStr = formatSimClock(runtimeRef.current.combatStats.simElapsedSec);

            const baseDmg = s.isOpeningShot
              ? 45 + Math.floor(Math.random() * 30)
              : 28 + Math.floor(Math.random() * 26);

            let newHp = 0;
            let wasDestroyed = false;

            if (targetKin && !targetKin.destroyed) {
              targetKin.hp = Math.max(0, targetKin.hp - baseDmg);
              newHp = Math.round(targetKin.hp);
              if (s.isOpeningShot) {
                targetKin.suppressedUntilSimSec =
                  runtimeRef.current.combatStats.simElapsedSec + 900;
              }
              if (targetKin.hp <= 0) {
                targetKin.destroyed = true;
                wasDestroyed = true;
                if (attackerKin) {
                  attackerKin.kills += 1;
                }
              }
            }

            const logItem: CombatEngagementLogItem = {
              id: `${s.id}-HIT`,
              simTimeLabel: simClockStr,
              attackerCallsign: s.attackerCallsign,
              attackerAllegiance: s.attackerAllegiance,
              targetCallsign: s.targetCallsign,
              isOpeningShot: s.isOpeningShot,
              losStatus: s.losStatus,
              terrainModifierPct: s.terrainModifierPct,
              forceRatioModifierPct: s.forceRatioModifierPct,
              hitProbabilityPct: s.hitProbabilityPct,
              rolledPct: s.rolledPct,
              outcome: wasDestroyed ? 'CRITICAL DESTRUCTION' : 'HIT',
              damageDealt: baseDmg,
              targetRemainingHp: newHp,
            };

            runtimeRef.current.combatStats.surfaceImpacts += 1;
            runtimeRef.current.combatStats.lastEngagementLog = `[${simClockStr}] ${
              s.isOpeningShot ? 'OPENING SHOT ' : ''
            }${wasDestroyed ? 'DESTROYED TARGET' : 'DIRECT HIT'} (${s.rolledPct}% <= ${
              s.hitProbabilityPct
            }% Hit): ${s.corridorName} (-${baseDmg}% HP)`;
            runtimeRef.current.combatStats.recentEngagements = [
              logItem,
              ...runtimeRef.current.combatStats.recentEngagements.slice(0, 24),
            ];
          }
        }

        const waves = runtimeRef.current.activeShockwaves;
        for (let i = waves.length - 1; i >= 0; i--) {
          const w = waves[i];
          w.ageSec += rawDt;
          if (w.ageSec >= w.maxAgeSec) {
            viewer.entities.remove(w.entity);
            waves.splice(i, 1);
          }
        }

        // Compute aggregate Blue vs Red surviving & destroyed counts
        let blueAlive = 0;
        let redAlive = 0;
        let blueDead = 0;
        let redDead = 0;
        const statuses: SimUnitStatus[] = [];

        runtimeRef.current.kinematicsMap.forEach((k) => {
          const isBlue = isBlueAllegiance(k.baseAsset.allegiance);
          if (k.destroyed) {
            if (isBlue) blueDead++;
            else redDead++;
          } else {
            if (isBlue) blueAlive++;
            else redAlive++;
          }
          statuses.push({
            id: k.baseAsset.id,
            callsign: k.baseAsset.callsign,
            designation: k.baseAsset.designation,
            allegiance: k.baseAsset.allegiance,
            hp: Math.round(k.hp),
            destroyed: k.destroyed,
            hasFiredOpeningShot: k.hasFiredOpeningShot,
            kills: k.kills,
            lat: k.currentLat,
            lon: k.currentLon,
          });
        });

        runtimeRef.current.combatStats.activeThreats = salvos.length;
        runtimeRef.current.combatStats.activeInterceptors = salvos.filter(
          (s) => !s.resolved
        ).length;
        runtimeRef.current.combatStats.blueAliveCount = blueAlive;
        runtimeRef.current.combatStats.redAliveCount = redAlive;
        runtimeRef.current.combatStats.blueDestroyedCount = blueDead;
        runtimeRef.current.combatStats.redDestroyedCount = redDead;
        runtimeRef.current.combatStats.unitStatuses = statuses;

        propsRef.current.onCombatTelemetryUpdate({ ...runtimeRef.current.combatStats });
      }
    };

    viewer.scene.preUpdate.addEventListener(onPreUpdate);

    return () => {
      isDestroyed = true;
      handler.destroy();
      if (!viewer.isDestroyed()) {
        viewer.scene.preUpdate.removeEventListener(onPreUpdate);
        viewer.destroy();
      }
    };
  }, []);

  // Rebuild entities when mode or assets/events change
  useEffect(() => {
    if (viewMode === 'live-osint') {
      runtimeRef.current.clearSimulationProjectiles();
    } else if (viewMode === 'simulation') {
      runtimeRef.current.spawnDynamicEngagementWave(false);
    }
    runtimeRef.current.rebuildEntities();
  }, [
    viewMode,
    assets,
    events,
    selectedAssetId,
    selectedEventId,
    showRadarDomes,
    showPatrolTracks,
  ]);

  // Switch Basemap Layers
  useEffect(() => {
    const { satelliteLayer, voyagerLayer, tacticalDarkLayer, labelsLayer } = runtimeRef.current;
    if (satelliteLayer && voyagerLayer && tacticalDarkLayer && labelsLayer) {
      satelliteLayer.show = basemapStyle === 'satellite-hybrid';
      labelsLayer.show = basemapStyle === 'satellite-hybrid';
      voyagerLayer.show = basemapStyle === 'carto-voyager';
      tacticalDarkLayer.show = basemapStyle === 'tactical-dark';
    }
  }, [basemapStyle]);

  // Manual Salvo Launch Trigger in Simulation Mode
  useEffect(() => {
    if (salvoTriggerCount > 0 && viewMode === 'simulation') {
      runtimeRef.current.spawnDynamicEngagementWave(true);
    }
  }, [salvoTriggerCount, viewMode]);

  // Reset Simulation to Current Live Positions Trigger
  useEffect(() => {
    if (simResetTriggerCount > 0) {
      runtimeRef.current.resetSimulationToLivePositions();
      runtimeRef.current.rebuildEntities();
    }
  }, [simResetTriggerCount]);

  // Smooth Camera flyTo
  useEffect(() => {
    const v = runtimeRef.current.viewer;
    if (!v || v.isDestroyed() || !flyToTarget) return;

    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        flyToTarget.lon,
        flyToTarget.lat,
        flyToTarget.altMeters
      ),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
      duration: 1.5,
    });
  }, [flyToTarget]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-full relative overflow-hidden bg-[#040811] select-none ${
        viewMode === 'simulation' && placementModeActive ? 'cursor-crosshair' : ''
      }`}
      aria-label="CesiumJS WGS84 Master Live Global Intelligence View"
    />
  );
};
