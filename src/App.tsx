import React, { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Download,
  Plus,
  Play,
  Pause,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Eye,
  Crosshair,
  X,
  Check,
  ArrowUpDown,
  ShieldAlert,
  Radio,
  Layers,
  Flame,
  Clock,
  Sparkles,
  Globe,
  Target,
  ExternalLink,
  Loader2,
  MapPin,
} from 'lucide-react';
import {
  INITIAL_ASSETS,
  INITIAL_EVENTS,
  SIMULATION_SCENARIOS,
  MilitaryAsset,
  ConflictEvent,
  AssetDomain,
  AssetModelType,
  TheaterRegion,
  VerificationTier,
  TerrainCoverType,
} from './data/osintData';
import {
  CesiumMasterGlobe,
  GlobeViewBounds,
  LiveCombatTelemetry,
  BasemapStyle,
  computeOrdnanceSphereMaxRadiusMeters,
} from './cesium/CesiumMasterGlobe';
import {
  fetchLiveMilitaryTransponders,
  verifyAndDiscoverOsintAssets,
  runAiTacticalSimulationCommand,
  GroundingWebSource,
  AiTacticalCommandResult,
} from './services/liveOsintFeed';

type WorkspaceTab = 'master-globe' | 'simulation' | 'order-of-battle';
type DockPanelTab = 'in-view-feed' | 'combat-rolls' | 'ai-commander' | 'dossier' | 'layers';

function angularDistDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r1 = (lat1 * Math.PI) / 180;
  const r2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(r1) * Math.cos(r2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return (c * 180) / Math.PI;
}

function isWithinGlobeView(lat: number, lon: number, bounds: GlobeViewBounds): boolean {
  if (bounds.altitudeKm > 9500) {
    return angularDistDeg(lat, lon, bounds.lat, bounds.lon) <= 78;
  }
  const inLat = lat >= bounds.southDeg - 4 && lat <= bounds.northDeg + 4;
  let inLon = false;
  if (bounds.westDeg <= bounds.eastDeg) {
    inLon = lon >= bounds.westDeg - 5 && lon <= bounds.eastDeg + 5;
  } else {
    inLon = lon >= bounds.westDeg - 5 || lon <= bounds.eastDeg + 5;
  }
  return (
    (inLat && inLon) ||
    angularDistDeg(lat, lon, bounds.lat, bounds.lon) <= bounds.radiusDeg
  );
}

function formatSimTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  const remSecs = Math.floor(seconds % 60);
  return `+${String(hrs).padStart(2, '0')}h ${String(remMins).padStart(2, '0')}m ${String(
    remSecs
  ).padStart(2, '0')}s`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('master-globe');
  const [assets, setAssets] = useState<MilitaryAsset[]>(INITIAL_ASSETS);
  const [events, setEvents] = useState<ConflictEvent[]>(INITIAL_EVENTS);
  const [liveAdsbCount, setLiveAdsbCount] = useState<number>(0);

  // Harvest real live military ADS-B transponders on mount and refresh every 45s
  useEffect(() => {
    let active = true;
    const harvestAdsb = async () => {
      const liveTracks = await fetchLiveMilitaryTransponders();
      if (!active || liveTracks.length === 0) return;
      setLiveAdsbCount(liveTracks.length);
      setAssets((prev) => {
        const core = prev.filter((a) => !a.id.startsWith('ADSB-'));
        return [...core, ...liveTracks];
      });
    };
    harvestAdsb();
    const timer = setInterval(harvestAdsb, 45000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Google Search Grounding OSINT Verification State
  const [isVerifyingOsint, setIsVerifyingOsint] = useState<boolean>(false);
  const [osintSearchQuery, setOsintSearchQuery] = useState<string>('');
  const [osintIntelBrief, setOsintIntelBrief] = useState<string>(
    '25+ baseline strategic formations + live Mode-S ADS-B military transponders active. Click "Verify & Discover OSINT (Google Search)" to pull additional live deployments.'
  );
  const [osintGroundingSources, setOsintGroundingSources] = useState<GroundingWebSource[]>([]);
  const [osintError, setOsintError] = useState<string | null>(null);

  // Global / Registry Filters
  const [selectedTheater, setSelectedTheater] = useState<TheaterRegion | 'All'>('All');
  const [selectedDomain, setSelectedDomain] = useState<AssetDomain | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<
    'designation' | 'speedKnots' | 'combatRadiusKm' | 'personnelEstimate'
  >('designation');
  const [sortAsc, setSortAsc] = useState(true);

  // CesiumJS Globe & Layer State
  const [selectedAssetId, setSelectedAssetId] = useState<string>(INITIAL_ASSETS[0].id);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(INITIAL_EVENTS[0].id);
  const [showRadarDomes, setShowRadarDomes] = useState<boolean>(true);
  const [showPatrolTracks, setShowPatrolTracks] = useState<boolean>(true);
  const [basemapStyle, setBasemapStyle] = useState<BasemapStyle>('satellite-hybrid');
  const [filterByCameraView, setFilterByCameraView] = useState<boolean>(true);

  const [flyToTarget, setFlyToTarget] = useState<{
    lat: number;
    lon: number;
    altMeters: number;
    timestamp: number;
  } | null>(null);

  // Simulation Tab (Tab 2) Accelerated Time & Combat Physics Controls
  const [simPlaying, setSimPlaying] = useState<boolean>(true);
  const [simSpeedMultiplier, setSimSpeedMultiplier] = useState<number>(5);
  const [simDefenseEfficiency, setSimDefenseEfficiency] = useState<number>(78);
  const [openingShotBonusPct, setOpeningShotBonusPct] = useState<number>(22);
  const [terrainMaskingWeight, setTerrainMaskingWeight] = useState<number>(100);
  const [salvoTriggerCount, setSalvoTriggerCount] = useState<number>(0);
  const [simResetTriggerCount, setSimResetTriggerCount] = useState<number>(0);

  // Interactive Click-on-Globe 3D Asset Spawner (Simulation Tab)
  const [placementModeActive, setPlacementModeActive] = useState<boolean>(false);
  const [placeAllegiance, setPlaceAllegiance] = useState<
    'NATO / Coalition' | 'Russian Federation' | 'PLA / China' | 'Regional / Non-State'
  >('NATO / Coalition');
  const [placeModelType, setPlaceModelType] = useState<AssetModelType>('fighter');
  const [placeTerrainCover, setPlaceTerrainCover] =
    useState<TerrainCoverType>('Open Sea / Airspace');

  // AI Tactical Wargame Commander State (Simulation Tab)
  const [aiDirective, setAiDirective] = useState<string>('');
  const [isAiRunning, setIsAiRunning] = useState<boolean>(false);
  const [aiResult, setAiResult] = useState<AiTacticalCommandResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Live Camera View Rectangle Bounds from CesiumJS
  const [viewBounds, setViewBounds] = useState<GlobeViewBounds>({
    lat: 31.5,
    lon: 34.5,
    altitudeKm: 5200,
    westDeg: -5,
    southDeg: 5,
    eastDeg: 68,
    northDeg: 58,
    radiusDeg: 38,
  });

  // Simulation Tab Combat Telemetry
  const [combatStats, setCombatStats] = useState<LiveCombatTelemetry>({
    simElapsedSec: 0,
    activeThreats: 0,
    activeInterceptors: 0,
    midAirIntercepts: 0,
    surfaceImpacts: 0,
    blueAliveCount: 16,
    redAliveCount: 9,
    blueDestroyedCount: 0,
    redDestroyedCount: 0,
    lastEngagementLog:
      'Simulation initialized from current live ground positions — Opening Shot & Line-of-Sight physics active',
    recentEngagements: [],
    unitStatuses: [],
  });

  // Unified Bottom Dock State (Collapsible + Tabbed)
  const [isDockCollapsed, setIsDockCollapsed] = useState<boolean>(false);
  const [dockTab, setDockTab] = useState<DockPanelTab>('in-view-feed');

  // When switching between Master Live Globe and Simulation, default dock tab appropriately
  const handleSwitchWorkspaceTab = (tab: WorkspaceTab) => {
    setActiveTab(tab);
    if (tab === 'simulation') {
      setDockTab('combat-rolls');
      setIsDockCollapsed(false);
    } else if (tab === 'master-globe') {
      setPlacementModeActive(false);
      if (dockTab === 'combat-rolls' || dockTab === 'ai-commander') {
        setDockTab('in-view-feed');
      }
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key.toLowerCase() === 'h') {
        setIsDockCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Modal State for Logging New Verified OSINT Report / Ordnance Strike
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportType, setReportType] = useState<'event' | 'asset'>('event');
  const [newDesignation, setNewDesignation] = useState('');
  const [newCallsign, setNewCallsign] = useState('');
  const [newOperator, setNewOperator] = useState('');
  const [newAllegiance, setNewAllegiance] = useState<
    'NATO / Coalition' | 'Russian Federation' | 'PLA / China' | 'Regional / Non-State'
  >('NATO / Coalition');
  const [newDomain, setNewDomain] = useState<AssetDomain>('Maritime');
  const [newModelType, setNewModelType] = useState<AssetModelType>('destroyer');
  const [newTheater, setNewTheater] = useState<TheaterRegion>('Eastern Europe & Black Sea');
  const [newLat, setNewLat] = useState('48.27');
  const [newLon, setNewLon] = useState('37.19');
  const [newRadius, setNewRadius] = useState('450');
  const [newOrdnanceType, setNewOrdnanceType] = useState('FAB-1500M54 UMPK Glide Bomb');
  const [newOrdnanceCount, setNewOrdnanceCount] = useState('4');
  const [newOrdnanceYieldKg, setNewOrdnanceYieldKg] = useState('675');
  const [newDissipationMins, setNewDissipationMins] = useState('15');
  const [newSourceNote, setNewSourceNote] = useState('');

  // Filtered Assets
  const filteredAssets = useMemo(() => {
    return assets
      .filter((a) => {
        if (selectedTheater !== 'All' && a.theater !== selectedTheater) return false;
        if (selectedDomain !== 'All' && a.domain !== selectedDomain) return false;
        if (searchQuery.trim() !== '') {
          const q = searchQuery.toLowerCase();
          return (
            a.designation.toLowerCase().includes(q) ||
            a.callsign.toLowerCase().includes(q) ||
            a.unitClass.toLowerCase().includes(q) ||
            a.operator.toLowerCase().includes(q) ||
            a.id.toLowerCase().includes(q) ||
            a.publicSourceNote.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];
        if (typeof valA === 'string' && typeof valB === 'string') {
          return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return sortAsc ? Number(valA) - Number(valB) : Number(valB) - Number(valA);
      });
  }, [assets, selectedTheater, selectedDomain, searchQuery, sortField, sortAsc]);

  // Filtered Events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (selectedTheater !== 'All' && e.theater !== selectedTheater) return false;
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        return (
          e.title.toLowerCase().includes(q) ||
          e.ordnanceType.toLowerCase().includes(q) ||
          e.citationSummary.toLowerCase().includes(q) ||
          e.impactAssessment.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [events, selectedTheater, searchQuery]);

  // Entities Currently Inside Where the User is Looking on the CesiumJS Globe
  const inViewAssets = useMemo(() => {
    if (!filterByCameraView) return filteredAssets;
    return filteredAssets.filter((a) => isWithinGlobeView(a.lat, a.lon, viewBounds));
  }, [filteredAssets, filterByCameraView, viewBounds]);

  const inViewEvents = useMemo(() => {
    if (!filterByCameraView) return filteredEvents;
    return filteredEvents.filter((e) => isWithinGlobeView(e.lat, e.lon, viewBounds));
  }, [filteredEvents, filterByCameraView, viewBounds]);

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetId) || assets[0],
    [assets, selectedAssetId]
  );

  const selectedEvent = useMemo(
    () => (selectedEventId ? events.find((e) => e.id === selectedEventId) || null : null),
    [events, selectedEventId]
  );

  // Trigger Google Search Grounded OSINT Verification & Discovery
  const handleVerifyOsintWithGoogleSearch = async (customTheater?: string) => {
    setIsVerifyingOsint(true);
    setOsintError(null);
    try {
      const targetTheater =
        customTheater || (selectedTheater === 'All' ? 'Global All Active Theaters' : selectedTheater);
      const existingNames = assets.map((a) => a.callsign);
      const res = await verifyAndDiscoverOsintAssets(
        targetTheater,
        osintSearchQuery,
        existingNames
      );
      if (res.intelligenceBrief) {
        setOsintIntelBrief(res.intelligenceBrief);
      }
      if (res.groundingSources.length > 0) {
        setOsintGroundingSources(res.groundingSources);
      }
      if (res.discoveredAssets.length > 0) {
        setAssets((prev) => [...res.discoveredAssets, ...prev]);
        const firstNew = res.discoveredAssets[0];
        setSelectedAssetId(firstNew.id);
        setSelectedEventId(null);
        setFlyToTarget({
          lat: firstNew.lat,
          lon: firstNew.lon,
          altMeters: 1400000,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      setOsintError(err?.message || 'Google Search OSINT verification failed.');
    } finally {
      setIsVerifyingOsint(false);
    }
  };

  // Handle Click-on-Globe 3D Model Placement in Simulation Tab
  const handleGlobeClickPlaceAsset = (lat: number, lon: number) => {
    const modelLabels: Record<AssetModelType, { name: string; domain: AssetDomain; radius: number; init: number; hit: number }> = {
      carrier: { name: 'Carrier Strike Task Force', domain: 'Maritime', radius: 950, init: 90, hit: 80 },
      destroyer: { name: 'Aegis Guided-Missile Destroyer', domain: 'Maritime', radius: 520, init: 84, hit: 76 },
      submarine: { name: 'Attack / Cruise-Missile Submarine', domain: 'Subsurface', radius: 1100, init: 94, hit: 84 },
      fighter: { name: '5th-Gen Tactical Fighter Squadron', domain: 'Airspace', radius: 680, init: 92, hit: 83 },
      bomber: { name: 'Long-Range Stand-Off Strike Bomber', domain: 'Airspace', radius: 1200, init: 85, hit: 75 },
      awacs: { name: 'Airborne Early Warning & Control (AWACS)', domain: 'Airspace', radius: 750, init: 97, hit: 82 },
      armor: { name: 'Combined Arms Armored Mechanized Brigade', domain: 'Ground', radius: 140, init: 76, hit: 68 },
      sam: { name: 'Long-Range SAM / BMD Battery', domain: 'Strategic', radius: 480, init: 89, hit: 82 },
    };

    const spec = modelLabels[placeModelType];
    const indexNum = assets.length + 1;
    const prefix =
      placeAllegiance === 'NATO / Coalition'
        ? 'BLUE'
        : placeAllegiance === 'Russian Federation'
        ? 'RED-RU'
        : placeAllegiance === 'PLA / China'
        ? 'RED-PLA'
        : 'RED-REG';

    const spawned: MilitaryAsset = {
      id: `SIM-DEPLOY-${Date.now()}`,
      callsign: `${prefix}-${placeModelType.toUpperCase()}-${indexNum}`,
      designation: `Deployed ${placeAllegiance.split(' ')[0]} ${spec.name}`,
      unitClass: `Simulation Deployed 3D ${placeModelType.toUpperCase()} Unit`,
      operator: placeAllegiance,
      allegiance: placeAllegiance,
      domain: spec.domain,
      modelType: placeModelType,
      theater: 'Global Strategic Patrol',
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3)),
      altitudeMeters: spec.domain === 'Airspace' ? 9500 : 0,
      headingDeg: placeAllegiance === 'NATO / Coalition' ? 90 : 270,
      speedKnots: spec.domain === 'Airspace' ? 450 : spec.domain === 'Maritime' ? 24 : 14,
      combatRadiusKm: spec.radius,
      readinessState: 'Combat Action',
      verification: 'Multi-Source Geolocated OSINT',
      isLiveTransponder: false,
      lastReportedUtc: 'SIMULATION DEPLOYED NOW',
      lastFixAgeLabel: `Simulation Deployed · ${placeTerrainCover}`,
      publicSourceNote: `Interactive 3D unit placed at (${lat.toFixed(2)}°, ${lon.toFixed(2)}°) with Opening Shot Armed.`,
      personnelEstimate: 250,
      armamentSummary: 'Full Wargame Munition Loadout (Opening Shot Ready)',
      terrainCover: placeTerrainCover,
      firstStrikeInitiative: spec.init,
      baseHitProbabilityPct: spec.hit,
      patrolWaypoints: [
        [lat, lon],
        [lat + 1.1, lon + 1.4],
        [lat - 0.9, lon - 1.1],
      ],
    };

    setAssets((prev) => [spawned, ...prev]);
    setSelectedAssetId(spawned.id);
    setSelectedEventId(null);
    // Trigger an immediate engagement wave so the newly placed asset interacts right away
    setTimeout(() => {
      setSalvoTriggerCount((c) => c + 1);
    }, 120);
  };

  // Run AI Tactical Wargame Commander (Gemini 3.8 Flash + Google Search Grounding)
  const handleRunAiCommander = async (customPrompt?: string) => {
    setIsAiRunning(true);
    setAiError(null);
    try {
      const summaryLines = inViewAssets
        .slice(0, 18)
        .map(
          (a) =>
            `${a.callsign} (${a.designation}, ${a.allegiance}, ${a.modelType}, cover=${
              a.terrainCover || 'Open'
            }) at (${a.lat.toFixed(2)}, ${a.lon.toFixed(2)})`
        )
        .join('; ');

      const res = await runAiTacticalSimulationCommand(
        customPrompt ?? aiDirective,
        { lat: viewBounds.lat, lon: viewBounds.lon },
        `In-view units (${inViewAssets.length}): ${summaryLines}. Blue Alive: ${combatStats.blueAliveCount}, Red Alive: ${combatStats.redAliveCount}.`
      );
      setAiResult(res);

      if (res.spawnedAssets.length > 0) {
        setAssets((prev) => [...res.spawnedAssets, ...prev]);
        const firstSpawn = res.spawnedAssets[0];
        setSelectedAssetId(firstSpawn.id);
        setSelectedEventId(null);
        setFlyToTarget({
          lat: firstSpawn.lat,
          lon: firstSpawn.lon,
          altMeters: 1350000,
          timestamp: Date.now(),
        });
        setTimeout(() => {
          setSalvoTriggerCount((c) => c + 1);
        }, 200);
      }
    } catch (err: any) {
      setAiError(err?.message || 'AI Tactical Wargame Commander failed.');
    } finally {
      setIsAiRunning(false);
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'ID,Callsign,Designation,Class,Operator,Allegiance,Domain,Theater,Latitude,Longitude,LastReportedUTC,FixType,CombatRadiusKm',
    ];
    const csvRows = filteredAssets.map(
      (a) =>
        `"${a.id}","${a.callsign}","${a.designation}","${a.unitClass}","${a.operator}","${a.allegiance}","${a.domain}","${a.theater}",${a.lat},${a.lon},"${a.lastReportedUtc}","${a.lastFixAgeLabel}",${a.combatRadiusKm}`
    );
    const blob = new Blob([headers.concat(csvRows).join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute(
      'download',
      `aegis-osint-order-of-battle-${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleLogNewReport = (e: React.FormEvent) => {
    e.preventDefault();
    const latNum = parseFloat(newLat) || viewBounds.lat;
    const lonNum = parseFloat(newLon) || viewBounds.lon;
    const nowUtcStr = '2026-10-27 ' + new Date().toISOString().slice(11, 16) + ' UTC';

    if (reportType === 'asset') {
      const created: MilitaryAsset = {
        id: `OSINT-${100 + assets.length}`,
        callsign: (newCallsign.trim() || `FIX-${assets.length}`).toUpperCase(),
        designation: newDesignation.trim() || 'Reported Military Formation Fix',
        unitClass: 'Verified Public OSINT Formation',
        operator: newOperator.trim() || 'Sovereign Defense Force',
        allegiance: newAllegiance,
        domain: newDomain,
        modelType: newModelType,
        theater: newTheater,
        lat: Math.max(-80, Math.min(80, latNum)),
        lon: Math.max(-179, Math.min(179, lonNum)),
        altitudeMeters: newDomain === 'Airspace' ? 9500 : 0,
        headingDeg: 95,
        speedKnots: 0,
        combatRadiusKm: Math.max(50, parseInt(newRadius, 10) || 450),
        readinessState: 'Forward Deployed',
        verification: 'Multi-Source Geolocated OSINT' as VerificationTier,
        isLiveTransponder: false,
        lastReportedUtc: nowUtcStr,
        lastFixAgeLabel: 'Last Reported Fix · Analyst Logged OSINT',
        publicSourceNote:
          newSourceNote.trim() ||
          'Stationary last-reported location verified via public satellite/OSINT imagery.',
        personnelEstimate: 350,
        armamentSummary: 'Standard Theater Loadout',
        terrainCover:
          newDomain === 'Ground'
            ? 'Urban / Fortified Defilade'
            : newDomain === 'Strategic'
            ? 'Highland / Mountain Masking'
            : 'Open Sea / Airspace',
        firstStrikeInitiative: 84,
        baseHitProbabilityPct: 75,
        patrolWaypoints: [
          [latNum, lonNum],
          [latNum + 1.2, lonNum + 1.5],
          [latNum - 0.8, lonNum + 0.6],
        ],
      };
      setAssets((prev) => [created, ...prev]);
      setSelectedAssetId(created.id);
      setSelectedEventId(null);
      setFlyToTarget({
        lat: created.lat,
        lon: created.lon,
        altMeters: 1100000,
        timestamp: Date.now(),
      });
      setDockTab('dossier');
    } else {
      const countNum = Math.max(1, parseInt(newOrdnanceCount, 10) || 4);
      const yieldNum = Math.max(10, parseInt(newOrdnanceYieldKg, 10) || 500);
      const minsNum = Math.min(15, Math.max(10, parseInt(newDissipationMins, 10) || 15));

      const createdEvt: ConflictEvent = {
        id: `STRIKE-${900 + events.length + 1}`,
        title: newDesignation.trim() || 'Verified Theater Ordnance Strike',
        theater: newTheater,
        category: 'Airstrike / Glide Bomb',
        lat: Math.max(-80, Math.min(80, latNum)),
        lon: Math.max(-179, Math.min(179, lonNum)),
        timestampUtc: 'ACTIVE STRIKE · Just detonated (0m 05s ago)',
        severityLevel: 'Critical',
        verifiedSourcesCount: 4,
        citationSummary: newOperator.trim() || 'NASA FIRMS VIIRS Thermal Flash + Geolocated OSINT',
        impactAssessment:
          newSourceNote.trim() ||
          `Detonation of ${countNum}x ${newOrdnanceType} (${(
            countNum * yieldNum
          ).toLocaleString()} kg total HE); slow 3D blast sphere expanding over ${minsNum} minutes.`,
        ordnanceType: newOrdnanceType.trim() || 'Precision Guided Munition',
        ordnanceCount: countNum,
        ordnanceYieldKg: yieldNum,
        dissipationMinutes: minsNum,
        initialElapsedSeconds: 5,
      };
      setEvents((prev) => [createdEvt, ...prev]);
      setSelectedEventId(createdEvt.id);
      setFlyToTarget({
        lat: createdEvt.lat,
        lon: createdEvt.lon,
        altMeters: 950000,
        timestamp: Date.now(),
      });
      setDockTab('dossier');
    }

    setNewDesignation('');
    setNewCallsign('');
    setNewOperator('');
    setNewSourceNote('');
    setIsReportModalOpen(false);
  };

  const flyToTheaterPreset = (
    region:
      | 'Global'
      | 'Middle East & Red Sea'
      | 'Eastern Europe & Black Sea'
      | 'Indo-Pacific & Taiwan Strait'
      | 'North Atlantic, Baltic & Arctic'
  ) => {
    switch (region) {
      case 'Middle East & Red Sea':
        setFlyToTarget({ lat: 19.5, lon: 40.5, altMeters: 2350000, timestamp: Date.now() });
        break;
      case 'Eastern Europe & Black Sea':
        setFlyToTarget({ lat: 48.0, lon: 35.0, altMeters: 1650000, timestamp: Date.now() });
        break;
      case 'Indo-Pacific & Taiwan Strait':
        setFlyToTarget({ lat: 22.8, lon: 123.5, altMeters: 2650000, timestamp: Date.now() });
        break;
      case 'North Atlantic, Baltic & Arctic':
        setFlyToTarget({ lat: 60.5, lon: 23.0, altMeters: 2650000, timestamp: Date.now() });
        break;
      case 'Global':
      default:
        setFlyToTarget({ lat: 31.5, lon: 34.5, altMeters: 5200000, timestamp: Date.now() });
        break;
    }
  };

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#0F172A] text-slate-100">
      {/* Top Bar Contract: Zone 1 (1-line Brand), Zone 2 (3 clean nav links: Master Live Globe, Simulation, Order of Battle), Zone 3 (1 primary action) */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 border-b border-slate-800 bg-[#0F172A] shrink-0 z-30">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            handleSwitchWorkspaceTab('master-globe');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          Aegis Global OSINT
        </a>

        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400 overflow-x-auto">
          <button
            type="button"
            onClick={() => handleSwitchWorkspaceTab('master-globe')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'master-globe'
                ? 'text-slate-100 border-sky-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Master Live Globe
          </button>
          <button
            type="button"
            onClick={() => handleSwitchWorkspaceTab('simulation')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'simulation'
                ? 'text-slate-100 border-sky-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Simulation
          </button>
          <button
            type="button"
            onClick={() => handleSwitchWorkspaceTab('order-of-battle')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'order-of-battle'
                ? 'text-slate-100 border-sky-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Order of Battle ({assets.length} Units · {events.length} Strikes)
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => {
              setNewLat(viewBounds.lat.toFixed(2));
              setNewLon(viewBounds.lon.toFixed(2));
              setReportType(activeTab === 'simulation' ? 'asset' : 'event');
              setIsReportModalOpen(true);
            }}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 rounded-md hover:bg-sky-300 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Log OSINT Strike / Unit</span>
          </button>
        </div>
      </header>

      {/* TAB 1 (MASTER LIVE GLOBE) OR TAB 2 (SIMULATION): Shared CesiumJS Engine */}
      {activeTab === 'master-globe' || activeTab === 'simulation' ? (
        <div className="flex-1 relative w-full h-full overflow-hidden">
          <CesiumMasterGlobe
            viewMode={activeTab === 'master-globe' ? 'live-osint' : 'simulation'}
            assets={filteredAssets}
            events={filteredEvents}
            selectedAssetId={selectedAssetId}
            selectedEventId={selectedEventId}
            showRadarDomes={showRadarDomes}
            showPatrolTracks={showPatrolTracks}
            basemapStyle={basemapStyle}
            simPlaying={simPlaying}
            simSpeedMultiplier={simSpeedMultiplier}
            interceptorEfficiencyPct={simDefenseEfficiency}
            openingShotBonusPct={openingShotBonusPct}
            terrainMaskingWeight={terrainMaskingWeight}
            salvoTriggerCount={salvoTriggerCount}
            simResetTriggerCount={simResetTriggerCount}
            placementModeActive={placementModeActive}
            flyToTarget={flyToTarget}
            onSelectAsset={(id) => {
              setSelectedAssetId(id);
              setSelectedEventId(null);
              setDockTab('dossier');
              setIsDockCollapsed(false);
            }}
            onSelectEvent={(id) => {
              setSelectedEventId(id);
              setDockTab('dossier');
              setIsDockCollapsed(false);
            }}
            onGlobeClickPlaceAsset={handleGlobeClickPlaceAsset}
            onViewBoundsChange={setViewBounds}
            onCombatTelemetryUpdate={setCombatStats}
          />

          {/* Top-Left HUD Badge */}
          <div className="absolute top-3 left-5 z-20 pointer-events-auto flex flex-col gap-1.5 max-w-[94vw]">
            <div className="px-3.5 py-2 rounded-md bg-[#090F1D]/92 border border-slate-800 text-xs text-slate-300 flex flex-wrap items-center gap-3 shadow-lg">
              <span className="font-semibold text-slate-100 font-display flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  {activeTab === 'master-globe'
                    ? 'MASTER LIVE OSINT VIEW (Last Reported Fixes + Active Ordnance Spheres)'
                    : `ACCELERATED WARGAME SIMULATION (${formatSimTime(combatStats.simElapsedSec)} @ ${simSpeedMultiplier}x)`}
                </span>
              </span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span className="font-mono tabular-nums text-sky-400">
                Gaze:{' '}
                {viewBounds.lat >= 0
                  ? `${viewBounds.lat.toFixed(2)}°N`
                  : `${Math.abs(viewBounds.lat).toFixed(2)}°S`}
                ,{' '}
                {viewBounds.lon >= 0
                  ? `${viewBounds.lon.toFixed(2)}°E`
                  : `${Math.abs(viewBounds.lon).toFixed(2)}°W`}{' '}
                ({viewBounds.altitudeKm.toLocaleString()} km)
              </span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span className="font-mono tabular-nums text-slate-100">
                In Camera View: {inViewAssets.length} Units · {inViewEvents.length} Ordnance Strikes
              </span>
              {liveAdsbCount > 0 && (
                <>
                  <span aria-hidden="true" className="text-slate-600">
                    ·
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400 flex items-center gap-1">
                    <Radio className="w-3 h-3" />
                    <span>+{liveAdsbCount} Live ADS-B Mil Transponders</span>
                  </span>
                </>
              )}
            </div>

            {activeTab === 'master-globe' ? (
              <div className="px-3.5 py-1.5 rounded-md bg-[#090F1D]/92 border border-slate-800 text-[11px] text-slate-300 flex flex-wrap items-center gap-2.5 shadow-lg">
                <span className="flex items-center gap-1 text-red-400 font-medium">
                  <Flame className="w-3.5 h-3.5" />
                  <span>Ordnance Spheres:</span>
                </span>
                <span>10–15 min slow expansion scaled by munition count & yield</span>
                <span aria-hidden="true">·</span>
                <span className="flex items-center gap-1 text-sky-300">
                  <Clock className="w-3 h-3" />
                  <span>Ships & units anchored to Last Reported Coordinates</span>
                </span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  disabled={isVerifyingOsint}
                  onClick={() => handleVerifyOsintWithGoogleSearch()}
                  className="px-2.5 py-0.5 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-300 font-semibold flex items-center gap-1 transition-colors disabled:opacity-50"
                >
                  {isVerifyingOsint ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Globe className="w-3 h-3" />
                  )}
                  <span>
                    {isVerifyingOsint
                      ? 'Searching Live OSINT...'
                      : 'Verify & Discover Live OSINT (Google Search)'}
                  </span>
                </button>
              </div>
            ) : (
              /* SIMULATION MODE TOP BAR: Force Ratio, Placement Tool & Live Hit-Roll Status */
              <div className="flex flex-col gap-1.5">
                <div className="px-3.5 py-1.5 rounded-md bg-[#090F1D]/92 border border-slate-800 text-[11px] text-slate-300 flex flex-wrap items-center gap-3 shadow-lg">
                  <span className="font-mono tabular-nums text-sky-400 font-semibold">
                    Blue Force: {combatStats.blueAliveCount} Active ({combatStats.blueDestroyedCount}{' '}
                    Lost)
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-red-400 font-semibold">
                    Red Force: {combatStats.redAliveCount} Active ({combatStats.redDestroyedCount}{' '}
                    Lost)
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    Intercepts/Misses: {combatStats.midAirIntercepts}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-amber-300">
                    Direct Hits: {combatStats.surfaceImpacts}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-200 truncate max-w-md font-mono">
                    {combatStats.lastEngagementLog}
                  </span>
                </div>

                {/* Interactive Click-to-Place New 3D Asset Bar in Simulation Tab */}
                <div className="px-3.5 py-1.5 rounded-md bg-[#090F1D]/95 border border-slate-800 text-xs flex flex-wrap items-center gap-2 shadow-lg">
                  <button
                    type="button"
                    onClick={() => setPlacementModeActive(!placementModeActive)}
                    className={`px-2.5 py-1 rounded font-semibold flex items-center gap-1.5 transition-colors ${
                      placementModeActive
                        ? 'bg-emerald-400 text-slate-950'
                        : 'bg-slate-800 text-sky-300 hover:bg-slate-700 border border-slate-700'
                    }`}
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    <span>
                      {placementModeActive
                        ? 'CLICK GLOBE TO DROP 3D UNIT (ACTIVE)'
                        : '+ Add 3D Asset on Globe'}
                    </span>
                  </button>

                  <select
                    aria-label="Allegiance for deployed simulation asset"
                    value={placeAllegiance}
                    onChange={(e) => setPlaceAllegiance(e.target.value as any)}
                    className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-200 text-[11px]"
                  >
                    <option value="NATO / Coalition">Blue: NATO / Coalition</option>
                    <option value="Russian Federation">Red: Russian Federation</option>
                    <option value="PLA / China">Red: PLA / China</option>
                    <option value="Regional / Non-State">Red: Regional Force</option>
                  </select>

                  <select
                    aria-label="3D glTF model class for deployed simulation asset"
                    value={placeModelType}
                    onChange={(e) => setPlaceModelType(e.target.value as AssetModelType)}
                    className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-200 text-[11px]"
                  >
                    <option value="fighter">5th-Gen Fighter Squadron (High Initiative)</option>
                    <option value="sam">SAM / BMD Battery (Patriot / S-400)</option>
                    <option value="destroyer">Aegis Destroyer (DDG)</option>
                    <option value="carrier">Aircraft Carrier (CVN)</option>
                    <option value="submarine">Stealth Submarine (SSGN / AIP)</option>
                    <option value="awacs">AWACS Radar Plane (Boosts Sector LOS)</option>
                    <option value="bomber">Strategic Strike Bomber</option>
                    <option value="armor">Armored Mechanized Brigade</option>
                  </select>

                  <select
                    aria-label="Terrain cover modifier for deployed simulation asset"
                    value={placeTerrainCover}
                    onChange={(e) => setPlaceTerrainCover(e.target.value as TerrainCoverType)}
                    className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-200 text-[11px]"
                  >
                    <option value="Open Sea / Airspace">Open Sea / Air (+8% Clear LOS)</option>
                    <option value="Coastal / Littoral Clutter">Coastal Clutter (-6% Hit)</option>
                    <option value="Urban / Fortified Defilade">Fortified Defilade (-12% Hit)</option>
                    <option value="Highland / Mountain Masking">Mountain Masking (-18% Hit)</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => handleGlobeClickPlaceAsset(viewBounds.lat, viewBounds.lon)}
                    className="px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-300 text-[11px] font-medium transition-colors"
                  >
                    Drop at Camera Center
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Unified Collapsible Bottom Dock */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-[95vw] max-w-[1120px] flex flex-col items-center pointer-events-auto">
            <button
              type="button"
              onClick={() => setIsDockCollapsed(!isDockCollapsed)}
              className="px-4 py-1.5 rounded-t-md bg-[#090F1D] border border-b-0 border-slate-800 text-xs font-medium text-slate-300 hover:text-slate-100 flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              {isDockCollapsed ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5 text-sky-400" />
                  <span>
                    Expand{' '}
                    {activeTab === 'master-globe'
                      ? `In-View Public Intelligence (${inViewAssets.length} Units · ${inViewEvents.length} Ordnance Strikes)`
                      : '3D Wargame Hit-Roll Telemetry & AI Tactical Commander'}{' '}
                    [H]
                  </span>
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5 text-sky-400" />
                  <span>Collapse Bottom Dock [H]</span>
                </>
              )}
            </button>

            {!isDockCollapsed && (
              <div className="w-full rounded-lg bg-[#090F1D]/95 border border-slate-800 shadow-2xl overflow-hidden">
                {/* Top Dock Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-900/90">
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-md border border-slate-800 overflow-x-auto">
                    <button
                      type="button"
                      onClick={() => setDockTab('in-view-feed')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                        dockTab === 'in-view-feed'
                          ? 'bg-slate-800 text-sky-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      In-View Units & Strikes ({inViewAssets.length + inViewEvents.length})
                    </button>

                    {activeTab === 'simulation' && (
                      <>
                        <button
                          type="button"
                          onClick={() => setDockTab('combat-rolls')}
                          className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                            dockTab === 'combat-rolls'
                              ? 'bg-slate-800 text-sky-300'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Opening Shot & Hit-Roll Log ({combatStats.recentEngagements.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setDockTab('ai-commander')}
                          className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 ${
                            dockTab === 'ai-commander'
                              ? 'bg-slate-800 text-sky-300'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <Sparkles className="w-3 h-3 text-sky-400" />
                          <span>AI Tactical Wargame Engine</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => setDockTab('dossier')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                        dockTab === 'dossier'
                          ? 'bg-slate-800 text-sky-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Target Dossier ({selectedEvent ? selectedEvent.id : selectedAsset?.callsign})
                    </button>
                    <button
                      type="button"
                      onClick={() => setDockTab('layers')}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                        dockTab === 'layers'
                          ? 'bg-slate-800 text-sky-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {activeTab === 'simulation'
                        ? 'Hit % Modifiers, LOS & Speed'
                        : 'CARTO Basemaps & Search Grounding'}
                    </button>
                  </div>

                  {/* Theater Quick-Fly & Simulation Action Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        ['Ukraine / Donbas', 'Eastern Europe & Black Sea'],
                        ['Red Sea / Levant', 'Middle East & Red Sea'],
                        ['Taiwan Strait', 'Indo-Pacific & Taiwan Strait'],
                        ['Baltic / Arctic', 'North Atlantic, Baltic & Arctic'],
                        ['Global', 'Global'],
                      ] as const
                    ).map(([label, reg]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => flyToTheaterPreset(reg)}
                        className="px-2.5 py-1 text-[11px] font-medium rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        {label}
                      </button>
                    ))}

                    {activeTab === 'simulation' && (
                      <>
                        <button
                          type="button"
                          onClick={() => setSimPlaying(!simPlaying)}
                          className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 ${
                            simPlaying
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          }`}
                        >
                          {simPlaying ? (
                            <Pause className="w-3 h-3" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                          <span>{simPlaying ? 'Pause' : 'Play'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSimResetTriggerCount((c) => c + 1)}
                          title="Reset all units to their current live OSINT positions and 100% HP"
                          className="px-2.5 py-1 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Reset to Live Positions</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSalvoTriggerCount((c) => c + 1)}
                          className="px-3 py-1 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>Fire Opening Salvo Wave</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* DOCK TAB 1: IN-VIEW INTELLIGENCE FEED */}
                {dockTab === 'in-view-feed' && (
                  <div className="p-3 max-h-56 overflow-y-auto">
                    {inViewAssets.length === 0 && inViewEvents.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-400 space-y-2">
                        <p>
                          No reported formations or active ordnance strikes inside current camera
                          view ({viewBounds.lat.toFixed(1)}°, {viewBounds.lon.toFixed(1)}°).
                        </p>
                        <button
                          type="button"
                          onClick={() => flyToTheaterPreset('Global')}
                          className="px-3 py-1 rounded bg-slate-800 text-sky-400 hover:bg-slate-700"
                        >
                          Reset to Global View
                        </button>
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="py-1.5 px-3 font-medium">ID / Callsign</th>
                            <th className="py-1.5 px-3 font-medium">
                              Ordnance Strike / Military Asset in Camera View
                            </th>
                            <th className="py-1.5 px-3 font-medium">
                              {activeTab === 'simulation'
                                ? 'Initiative / Base Hit % / Terrain Cover'
                                : 'Ordnance Payload / Verification Source'}
                            </th>
                            <th className="py-1.5 px-3 font-medium">
                              Sphere Expansion / Last Reported Timestamp
                            </th>
                            <th className="py-1.5 px-3 font-medium text-right">WGS84 Fix</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {inViewEvents.map((evt) => {
                            const totalHeKg = evt.ordnanceCount * evt.ordnanceYieldKg;
                            const maxRadKm = (
                              computeOrdnanceSphereMaxRadiusMeters(
                                evt.ordnanceCount,
                                evt.ordnanceYieldKg
                              ) / 1000
                            ).toFixed(1);
                            const isSel = selectedEventId === evt.id;

                            return (
                              <tr
                                key={evt.id}
                                onClick={() => {
                                  setSelectedEventId(evt.id);
                                  setFlyToTarget({
                                    lat: evt.lat,
                                    lon: evt.lon,
                                    altMeters: 420000,
                                    timestamp: Date.now(),
                                  });
                                  setDockTab('dossier');
                                }}
                                className={`cursor-pointer transition-colors h-8 ${
                                  isSel
                                    ? 'bg-red-900/40 text-white'
                                    : 'bg-red-950/20 hover:bg-red-900/30 text-slate-100'
                                }`}
                              >
                                <td className="py-1 px-3 font-mono tabular-nums text-red-400 font-semibold whitespace-nowrap">
                                  {evt.id}
                                </td>
                                <td className="py-1 px-3 font-medium whitespace-nowrap">
                                  {evt.title}
                                </td>
                                <td className="py-1 px-3 font-mono tabular-nums text-amber-300 whitespace-nowrap">
                                  {evt.ordnanceCount}x {evt.ordnanceType} (
                                  {totalHeKg.toLocaleString()} kg HE · {maxRadKm} km sphere)
                                </td>
                                <td className="py-1 px-3 text-red-300 whitespace-nowrap">
                                  Slow Sphere Expansion ({evt.dissipationMinutes} min window) ·{' '}
                                  {evt.timestampUtc}
                                </td>
                                <td className="py-1 px-3 font-mono tabular-nums text-right whitespace-nowrap">
                                  {evt.lat.toFixed(2)}°N, {evt.lon.toFixed(2)}°E
                                </td>
                              </tr>
                            );
                          })}

                          {inViewAssets.map((asset) => {
                            const isSel = selectedAsset?.id === asset.id && !selectedEventId;
                            const simStatus = combatStats.unitStatuses.find(
                              (u) => u.id === asset.id
                            );
                            return (
                              <tr
                                key={asset.id}
                                onClick={() => {
                                  setSelectedAssetId(asset.id);
                                  setSelectedEventId(null);
                                  setFlyToTarget({
                                    lat: asset.lat,
                                    lon: asset.lon,
                                    altMeters: 950000,
                                    timestamp: Date.now(),
                                  });
                                  setDockTab('dossier');
                                }}
                                className={`cursor-pointer transition-colors h-8 ${
                                  isSel
                                    ? 'bg-sky-500/20 text-white'
                                    : 'hover:bg-slate-800/60 text-slate-200'
                                }`}
                              >
                                <td className="py-1 px-3 font-mono tabular-nums text-sky-400 font-semibold whitespace-nowrap">
                                  {asset.callsign}
                                </td>
                                <td className="py-1 px-3 font-medium whitespace-nowrap">
                                  {asset.designation}
                                </td>
                                <td className="py-1 px-3 text-slate-300 whitespace-nowrap font-mono">
                                  {activeTab === 'simulation'
                                    ? `Init ${asset.firstStrikeInitiative || 80} · Base Hit ${
                                        asset.baseHitProbabilityPct || 74
                                      }% · ${asset.terrainCover || 'Open'}`
                                    : asset.lastFixAgeLabel}
                                </td>
                                <td className="py-1 px-3 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                                  {activeTab === 'simulation' && simStatus
                                    ? simStatus.destroyed
                                      ? 'DESTROYED (0% HP)'
                                      : `HP ${simStatus.hp}% · ${
                                          simStatus.hasFiredOpeningShot
                                            ? 'Engaged'
                                            : 'Opening Shot Ready'
                                        }`
                                    : asset.isLiveTransponder
                                    ? `LIVE TRANSPONDER (${asset.lastReportedUtc})`
                                    : `Last Reported: ${asset.lastReportedUtc}`}
                                </td>
                                <td className="py-1 px-3 font-mono tabular-nums text-right whitespace-nowrap">
                                  {asset.lat.toFixed(2)}°N, {asset.lon.toFixed(2)}°E
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* DOCK TAB 2 (SIMULATION): OPENING SHOT, LINE-OF-SIGHT & RANDOM % HIT-ROLL LOG */}
                {dockTab === 'combat-rolls' && (
                  <div className="p-3 max-h-56 overflow-y-auto space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs pb-2 border-b border-slate-800">
                      <div className="text-slate-300">
                        <span className="font-semibold text-slate-100">
                          Combat Resolution Formula:{' '}
                        </span>
                        <span className="font-mono text-sky-300">
                          Hit % = Base Accuracy + Opening Shot Bonus (+{openingShotBonusPct}%) +
                          LOS/Terrain Modifier + Force Ratio Bonus − Defense Screen
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSalvoTriggerCount((c) => c + 1)}
                        className="px-2.5 py-1 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 border border-sky-400/40 font-medium"
                      >
                        Trigger Immediate Engagement Roll
                      </button>
                    </div>

                    {combatStats.recentEngagements.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-400">
                        Missiles in flight — hit probability rolls, Line-of-Sight checks, and
                        Opening Shot outcomes will appear here as salvos resolve.
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="py-1 px-2 font-medium">Sim Time</th>
                            <th className="py-1 px-2 font-medium">Attacker → Target</th>
                            <th className="py-1 px-2 font-medium">Shot Type</th>
                            <th className="py-1 px-2 font-medium">Line of Sight & Terrain</th>
                            <th className="py-1 px-2 font-medium text-right">Force Ratio</th>
                            <th className="py-1 px-2 font-medium text-right">Hit % vs Roll</th>
                            <th className="py-1 px-2 font-medium text-right">Outcome</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                          {combatStats.recentEngagements.map((item) => (
                            <tr key={item.id} className="hover:bg-slate-800/50">
                              <td className="py-1 px-2 text-slate-400 whitespace-nowrap">
                                {item.simTimeLabel}
                              </td>
                              <td className="py-1 px-2 text-slate-100 font-semibold whitespace-nowrap">
                                {item.attackerCallsign} → {item.targetCallsign}
                              </td>
                              <td className="py-1 px-2 whitespace-nowrap">
                                {item.isOpeningShot ? (
                                  <span className="text-amber-300 font-semibold">
                                    OPENING SHOT (+{openingShotBonusPct}%)
                                  </span>
                                ) : (
                                  <span className="text-slate-400">Follow-up Salvo</span>
                                )}
                              </td>
                              <td className="py-1 px-2 text-slate-300 whitespace-nowrap">
                                {item.losStatus} (
                                {item.terrainModifierPct >= 0
                                  ? `+${item.terrainModifierPct}%`
                                  : `${item.terrainModifierPct}%`}
                                )
                              </td>
                              <td className="py-1 px-2 text-right text-sky-300 whitespace-nowrap">
                                {item.forceRatioModifierPct >= 0
                                  ? `+${item.forceRatioModifierPct}%`
                                  : `${item.forceRatioModifierPct}%`}
                              </td>
                              <td className="py-1 px-2 text-right text-slate-200 whitespace-nowrap">
                                {item.hitProbabilityPct}% (Rolled {item.rolledPct}%)
                              </td>
                              <td className="py-1 px-2 text-right font-semibold whitespace-nowrap">
                                {item.outcome === 'CRITICAL DESTRUCTION' ? (
                                  <span className="text-red-400">
                                    DESTROYED (-{item.damageDealt}% HP)
                                  </span>
                                ) : item.outcome === 'HIT' ? (
                                  <span className="text-amber-400">
                                    HIT (-{item.damageDealt}% → {item.targetRemainingHp}% HP)
                                  </span>
                                ) : (
                                  <span className="text-emerald-400">INTERCEPTED / MISSED</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* DOCK TAB 3 (SIMULATION): AI TACTICAL WARGAME ENGINE (GEMINI 3.8 FLASH + GOOGLE SEARCH) */}
                {dockTab === 'ai-commander' && (
                  <div className="p-4 text-xs space-y-3 max-h-60 overflow-y-auto">
                    <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
                      <div className="flex-1 relative">
                        <input
                          type="text"
                          value={aiDirective}
                          onChange={(e) => setAiDirective(e.target.value)}
                          placeholder="e.g. Spawn a US F-35C squadron & AWACS in the Taiwan Strait to seize the Opening Shot against PLAN Type 055..."
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={isAiRunning}
                        onClick={() => handleRunAiCommander()}
                        className="px-4 py-2 rounded-md bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                      >
                        {isAiRunning ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {isAiRunning
                            ? 'AI Analyzing & Spawning 3D Units...'
                            : 'Analyze LOS & Spawn AI Task Force'}
                        </span>
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-slate-400">Quick Wargame Injections:</span>
                      {[
                        'Deploy NATO AWACS + Patriot PAC-3 + F-16 squadron over Black Sea to counter S-400 & Su-34',
                        'Spawn Red Sea Houthi ASBM barrage vs USS Gravely & USS Truman CSG',
                        'Inject 5th-Gen J-20A vs F-22A Kadena Wing opening-shot duel over Miyako Strait',
                      ].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={isAiRunning}
                          onClick={() => {
                            setAiDirective(preset);
                            handleRunAiCommander(preset);
                          }}
                          className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors truncate max-w-xs"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>

                    {aiError && (
                      <div className="p-2.5 rounded bg-red-950/50 border border-red-800 text-red-300">
                        {aiError}
                      </div>
                    )}

                    {aiResult && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 rounded bg-slate-900/90 border border-slate-800">
                        <div className="md:col-span-2 space-y-1.5">
                          <div className="font-semibold text-sky-300 flex items-center gap-1.5">
                            <Target className="w-3.5 h-3.5" />
                            <span>AI Opening-Shot & Line-of-Sight Adjudication</span>
                          </div>
                          <p className="text-slate-200 leading-relaxed">
                            {aiResult.tacticalAssessment}
                          </p>
                          <p className="text-amber-300/90 leading-relaxed">
                            <span className="font-semibold">Opening Shot Advantage: </span>
                            {aiResult.openingShotAnalysis}
                          </p>
                        </div>

                        <div className="space-y-2 border-t md:border-t-0 md:border-l border-slate-800 pt-2 md:pt-0 md:pl-4">
                          <div className="flex items-center justify-between font-mono">
                            <span className="text-slate-400">Blue Win Probability:</span>
                            <span className="text-sky-400 font-bold">
                              {aiResult.predictedBlueWinProbabilityPct}%
                            </span>
                          </div>
                          <div className="text-slate-300">
                            Spawned{' '}
                            <span className="font-mono text-emerald-400 font-semibold">
                              {aiResult.spawnedAssets.length} new 3D units
                            </span>{' '}
                            directly into the active simulation.
                          </div>
                          {aiResult.groundingSources.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[11px] text-slate-400">
                                Google Search Grounding Sources:
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {aiResult.groundingSources.slice(0, 3).map((src) => (
                                  <a
                                    key={src.uri}
                                    href={src.uri}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-sky-300 hover:text-sky-200 text-[11px] max-w-[180px] truncate"
                                  >
                                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                    <span className="truncate">{src.title}</span>
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* DOCK TAB 4: SELECTED TARGET OR ORDNANCE STRIKE DOSSIER */}
                {dockTab === 'dossier' && (
                  <div className="p-4 text-xs">
                    {selectedEvent ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
                        <div>
                          <div className="text-slate-400">
                            <span className="font-mono text-red-400 font-semibold">
                              {selectedEvent.id}
                            </span>
                            <span aria-hidden="true"> · </span>
                            <span>{selectedEvent.category}</span>
                            <span aria-hidden="true"> · </span>
                            <span>{selectedEvent.severityLevel} Severity</span>
                          </div>
                          <h3 className="text-sm font-bold text-slate-100 font-display mt-1">
                            {selectedEvent.title}
                          </h3>
                          <div className="font-mono text-slate-400 mt-1 tabular-nums">
                            Impact Coordinates: {selectedEvent.lat.toFixed(2)}°N,{' '}
                            {selectedEvent.lon.toFixed(2)}°E
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2.5 font-mono tabular-nums border-x border-slate-800 px-4">
                          <div>
                            <div className="text-slate-400 font-sans">Ordnance Count & Type</div>
                            <div className="text-amber-300 font-semibold">
                              {selectedEvent.ordnanceCount}x{' '}
                              {selectedEvent.ordnanceType.split(' ')[0]}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Total HE Payload Mass</div>
                            <div className="text-red-400 font-semibold">
                              {(
                                selectedEvent.ordnanceCount * selectedEvent.ordnanceYieldKg
                              ).toLocaleString()}{' '}
                              kg HE
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Sphere Expansion Window</div>
                            <div className="text-slate-100">
                              {selectedEvent.dissipationMinutes} minutes (Slow)
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Max Blast Envelope</div>
                            <div className="text-slate-100">
                              {(
                                computeOrdnanceSphereMaxRadiusMeters(
                                  selectedEvent.ordnanceCount,
                                  selectedEvent.ordnanceYieldKg
                                ) / 1000
                              ).toFixed(1)}{' '}
                              km radius
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col justify-between h-full space-y-2">
                          <div>
                            <div className="text-slate-400 font-medium">
                              {selectedEvent.citationSummary}
                            </div>
                            <p className="text-slate-200 mt-0.5 leading-relaxed">
                              {selectedEvent.impactAssessment}
                            </p>
                          </div>
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                setFlyToTarget({
                                  lat: selectedEvent.lat,
                                  lon: selectedEvent.lon,
                                  altMeters: 350000,
                                  timestamp: Date.now(),
                                })
                              }
                              className="px-3 py-1 rounded bg-red-900/50 text-red-200 hover:bg-red-800/60"
                            >
                              Zoom Into Ordnance Sphere
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedEventId(null)}
                              className="text-sky-400 hover:text-sky-300"
                            >
                              Switch to Unit Dossier
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : selectedAsset ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
                        <div>
                          <div className="text-slate-400">
                            <span className="font-mono text-sky-400 font-semibold">
                              {selectedAsset.callsign} ({selectedAsset.id})
                            </span>
                            <span aria-hidden="true"> · </span>
                            <span>{selectedAsset.allegiance}</span>
                          </div>
                          <h3 className="text-sm font-bold text-slate-100 font-display mt-1">
                            {selectedAsset.designation}
                          </h3>
                          <div className="text-slate-400 mt-0.5">{selectedAsset.unitClass}</div>
                          <div className="text-slate-300 mt-1">
                            <span className="text-slate-500">Armament: </span>
                            {selectedAsset.armamentSummary}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2.5 font-mono tabular-nums border-x border-slate-800 px-4">
                          <div>
                            <div className="text-slate-400 font-sans">Last Reported Fix</div>
                            <div className="text-slate-100">
                              {selectedAsset.lat.toFixed(2)}°N, {selectedAsset.lon.toFixed(2)}°E
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Report Timestamp</div>
                            <div className="text-sky-300">{selectedAsset.lastReportedUtc}</div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Initiative / Base Hit %</div>
                            <div className="text-amber-300">
                              Init {selectedAsset.firstStrikeInitiative || 80} ·{' '}
                              {selectedAsset.baseHitProbabilityPct || 74}% Hit
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 font-sans">Terrain Cover / Reach</div>
                            <div className="text-slate-100">
                              {selectedAsset.terrainCover || 'Open'} ({selectedAsset.combatRadiusKm}{' '}
                              km)
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div>
                            <div className="text-slate-400 font-medium">
                              {selectedAsset.lastFixAgeLabel}
                            </div>
                            <p className="text-slate-200 mt-0.5 leading-relaxed">
                              {selectedAsset.publicSourceNote}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setFlyToTarget({
                                lat: selectedAsset.lat,
                                lon: selectedAsset.lon,
                                altMeters: 650000,
                                timestamp: Date.now(),
                              })
                            }
                            className="px-3 py-1 rounded bg-slate-800 text-sky-400 hover:bg-slate-700"
                          >
                            Zoom Camera to Unit Fix
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* DOCK TAB 5: CARTO BASEMAPS, GOOGLE SEARCH GROUNDING & SIMULATION PHYSICS CONTROLS */}
                {dockTab === 'layers' && (
                  <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-5 text-xs">
                    <div className="space-y-2">
                      <div className="text-slate-400 font-medium flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5 text-sky-400" />
                        <span>CARTO Authenticated Basemaps & Gaze Filter</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setBasemapStyle('satellite-hybrid')}
                          className={`px-2 py-1.5 rounded border transition-colors whitespace-nowrap truncate ${
                            basemapStyle === 'satellite-hybrid'
                              ? 'bg-slate-800 border-sky-400 text-sky-300'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          Satellite + CARTO
                        </button>
                        <button
                          type="button"
                          onClick={() => setBasemapStyle('carto-voyager')}
                          className={`px-2 py-1.5 rounded border transition-colors whitespace-nowrap truncate ${
                            basemapStyle === 'carto-voyager'
                              ? 'bg-slate-800 border-sky-400 text-sky-300'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          CARTO Voyager
                        </button>
                        <button
                          type="button"
                          onClick={() => setBasemapStyle('tactical-dark')}
                          className={`px-2 py-1.5 rounded border transition-colors whitespace-nowrap truncate ${
                            basemapStyle === 'tactical-dark'
                              ? 'bg-slate-800 border-sky-400 text-sky-300'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          CARTO Dark
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setShowRadarDomes(!showRadarDomes)}
                          className={`px-2.5 py-1.5 rounded border flex items-center justify-between transition-colors whitespace-nowrap ${
                            showRadarDomes
                              ? 'bg-slate-800 border-slate-700 text-sky-300'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          <span>3D Radar Domes</span>
                          <span className="font-mono">{showRadarDomes ? 'ON' : 'OFF'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setFilterByCameraView(!filterByCameraView)}
                          className={`px-2.5 py-1.5 rounded border flex items-center justify-between transition-colors whitespace-nowrap ${
                            filterByCameraView
                              ? 'bg-sky-500/15 border-sky-400/50 text-sky-300'
                              : 'bg-slate-900 border-slate-800 text-slate-400'
                          }`}
                        >
                          <span>Gaze Filter</span>
                          <span className="font-mono">{filterByCameraView ? 'ON' : 'ALL'}</span>
                        </button>
                      </div>
                    </div>

                    {activeTab === 'simulation' ? (
                      <>
                        <div className="space-y-2.5">
                          <div>
                            <div className="flex justify-between text-slate-300 mb-1">
                              <span>Accelerated Simulation Speed</span>
                              <span className="font-mono tabular-nums text-sky-400">
                                {simSpeedMultiplier}x Accelerated Time
                              </span>
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={60}
                              step={1}
                              value={simSpeedMultiplier}
                              onChange={(e) => setSimSpeedMultiplier(Number(e.target.value))}
                              className="w-full accent-sky-400"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-slate-300 mb-1">
                              <span>Opening Shot First-Strike Bonus</span>
                              <span className="font-mono tabular-nums text-amber-300">
                                +{openingShotBonusPct}% Hit Chance
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={40}
                              value={openingShotBonusPct}
                              onChange={(e) => setOpeningShotBonusPct(Number(e.target.value))}
                              className="w-full accent-sky-400"
                            />
                          </div>
                        </div>

                        <div className="space-y-2.5">
                          <div>
                            <div className="flex justify-between text-slate-300 mb-1">
                              <span>Terrain & Line-of-Sight Masking Effect</span>
                              <span className="font-mono tabular-nums text-emerald-400">
                                {terrainMaskingWeight}% Weight
                              </span>
                            </div>
                            <input
                              type="range"
                              min={25}
                              max={175}
                              value={terrainMaskingWeight}
                              onChange={(e) => setTerrainMaskingWeight(Number(e.target.value))}
                              className="w-full accent-sky-400"
                            />
                          </div>

                          <div>
                            <div className="flex justify-between text-slate-300 mb-1">
                              <span>SAM / Point-Defense Intercept Screen</span>
                              <span className="font-mono tabular-nums text-sky-300">
                                {simDefenseEfficiency}% Efficiency
                              </span>
                            </div>
                            <input
                              type="range"
                              min={30}
                              max={95}
                              value={simDefenseEfficiency}
                              onChange={(e) => setSimDefenseEfficiency(Number(e.target.value))}
                              className="w-full accent-sky-400"
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="md:col-span-2 p-3 rounded bg-slate-900/90 border border-slate-800 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-slate-100 font-semibold flex items-center gap-1.5">
                            <Globe className="w-3.5 h-3.5 text-sky-400" />
                            <span>
                              Google Search Grounded Live OSINT Verification (gemini-3.8-flash)
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={isVerifyingOsint}
                            onClick={() => handleVerifyOsintWithGoogleSearch()}
                            className="px-3 py-1 rounded bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300 transition-colors disabled:opacity-50 flex items-center gap-1"
                          >
                            {isVerifyingOsint && <Loader2 className="w-3 h-3 animate-spin" />}
                            <span>Verify & Add Live OSINT Units</span>
                          </button>
                        </div>
                        <p className="text-slate-300 leading-relaxed">{osintIntelBrief}</p>
                        {osintGroundingSources.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <span className="text-slate-400 text-[11px]">Verified Citations:</span>
                            {osintGroundingSources.slice(0, 4).map((src) => (
                              <a
                                key={src.uri}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-sky-300 hover:text-sky-200 text-[11px] max-w-[210px] truncate"
                              >
                                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                <span className="truncate">{src.title}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* TAB 3: ORDER OF BATTLE & GOOGLE SEARCH GROUNDED OSINT VERIFICATION */
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
          <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0F172A] p-5 flex flex-col justify-between gap-6 overflow-y-auto">
            <div className="space-y-6">
              <div>
                <label
                  htmlFor="global-osint-search"
                  className="block text-xs font-medium text-slate-400 mb-2"
                >
                  Search Callsigns, Ordnance & Citations
                </label>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="global-osint-search"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="e.g. Truman, F-22, S-400..."
                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                  />
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-400 mb-2">Active Theater Filter</div>
                <div className="space-y-1">
                  {(
                    [
                      'All',
                      'Eastern Europe & Black Sea',
                      'Middle East & Red Sea',
                      'Indo-Pacific & Taiwan Strait',
                      'North Atlantic, Baltic & Arctic',
                    ] as const
                  ).map((region) => {
                    const count =
                      region === 'All'
                        ? assets.length
                        : assets.filter((a) => a.theater === region).length;
                    const isSelected = selectedTheater === region;
                    return (
                      <button
                        key={region}
                        type="button"
                        onClick={() => setSelectedTheater(region)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                          isSelected
                            ? 'bg-slate-800 text-sky-300'
                            : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                        }`}
                      >
                        <span className="truncate">
                          {region === 'All' ? 'All Global Theaters' : region}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums ml-2">
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-400 mb-2">Operational Domain</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    ['All', 'Maritime', 'Airspace', 'Ground', 'Strategic', 'Subsurface'] as const
                  ).map((domain) => (
                    <button
                      key={domain}
                      type="button"
                      onClick={() => setSelectedDomain(domain)}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap text-left ${
                        selectedDomain === domain
                          ? 'bg-slate-800 text-sky-300 border border-slate-700'
                          : 'bg-slate-900/60 text-slate-400 hover:text-slate-200 border border-slate-800/80'
                      }`}
                    >
                      {domain}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={handleExportCsv}
                className="w-full px-3 py-2 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded-md hover:bg-slate-800 hover:text-slate-100 transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download OOB CSV</span>
              </button>
            </div>
          </aside>

          <main className="flex-1 min-w-0 p-6 space-y-6 overflow-y-auto">
            {/* Google Search Grounded OSINT Discovery Card */}
            <div className="border border-slate-800 rounded-lg bg-slate-900/50 p-5 space-y-3">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100 font-display flex items-center gap-2">
                    <Globe className="w-4 h-4 text-sky-400" />
                    <span>
                      Verify & Discover Additional Public Military Assets (Google Search Grounding)
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Uses Gemini 3.8 Flash with live Google Search to verify carrier strike groups,
                    air wings, and frontline deployments and plot them onto the Master Live Globe.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={osintSearchQuery}
                    onChange={(e) => setOsintSearchQuery(e.target.value)}
                    placeholder="Optional focus (e.g. USNI carrier tracker, Baltic fleet)..."
                    className="w-64 px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-md text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    disabled={isVerifyingOsint}
                    onClick={() => handleVerifyOsintWithGoogleSearch()}
                    className="px-3.5 py-1.5 text-xs font-semibold bg-sky-400 text-slate-950 rounded-md hover:bg-sky-300 transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                  >
                    {isVerifyingOsint ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isVerifyingOsint ? 'Searching Web OSINT...' : 'Run Google Search OSINT Scan'}
                    </span>
                  </button>
                </div>
              </div>

              {osintError && (
                <div className="p-2.5 rounded bg-red-950/50 border border-red-800 text-xs text-red-300">
                  {osintError}
                </div>
              )}

              <div className="text-xs text-slate-300 bg-slate-950/70 p-3 rounded border border-slate-800/80 space-y-2">
                <p>{osintIntelBrief}</p>
                {osintGroundingSources.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80">
                    <span className="text-slate-400">Google Search Grounding Citations:</span>
                    {osintGroundingSources.map((src) => (
                      <a
                        key={src.uri}
                        href={src.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-sky-300 hover:text-sky-200 text-[11px]"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>{src.title}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Global Order of Battle Table */}
            <div className="border border-slate-800 rounded-lg bg-slate-900/30 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-base font-semibold text-slate-100 font-display">
                    Global Order of Battle ({filteredAssets.length} Verified Units & Live ADS-B)
                  </h1>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Verified public locations with report timestamps, terrain cover, and first-shot
                    initiative ratings
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleSort('combatRadiusKm')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded-md hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    <span>Sort by Reach Radius</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSort('personnelEstimate')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded-md hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    <span>Sort by Personnel</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/70">
                      <th className="py-3 px-4 font-medium">Callsign</th>
                      <th className="py-3 px-4 font-medium">Unit Designation & Armament</th>
                      <th className="py-3 px-4 font-medium">Last Reported Timestamp & Source</th>
                      <th className="py-3 px-4 font-medium">Sim Initiative / Cover</th>
                      <th className="py-3 px-4 font-medium text-right">Last Known WGS84 Fix</th>
                      <th className="py-3 px-4 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {filteredAssets.map((asset) => (
                      <tr key={asset.id} className="hover:bg-slate-800/40 transition-colors h-12">
                        <td className="py-2.5 px-4 font-mono tabular-nums text-sky-400 font-semibold whitespace-nowrap">
                          {asset.callsign}
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-100">{asset.designation}</div>
                          <div className="text-slate-400 text-[11px]">{asset.armamentSummary}</div>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-mono text-slate-200 tabular-nums">
                            {asset.lastReportedUtc}
                          </div>
                          <div className="text-[11px] text-slate-400">{asset.lastFixAgeLabel}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-300 whitespace-nowrap">
                          <div>
                            Init {asset.firstStrikeInitiative || 80} · Hit{' '}
                            {asset.baseHitProbabilityPct || 74}%
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {asset.terrainCover || 'Open Sea / Airspace'}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-300 whitespace-nowrap">
                          {asset.lat.toFixed(2)}°N, {asset.lon.toFixed(2)}°E
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedAssetId(asset.id);
                              setSelectedEventId(null);
                              setFlyToTarget({
                                lat: asset.lat,
                                lon: asset.lon,
                                altMeters: 950000,
                                timestamp: Date.now(),
                              });
                              setActiveTab('master-globe');
                              setDockTab('dossier');
                            }}
                            className="px-2.5 py-1 text-xs font-medium text-sky-400 hover:text-sky-300 hover:bg-slate-800 rounded transition-colors inline-flex items-center gap-1"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Fly To Fix</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </main>
        </div>
      )}

      {/* Modal for Logging New Ordnance Strike or Last-Reported Asset Fix */}
      {isReportModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4">
          <div className="w-full max-w-lg border border-slate-800 rounded-lg bg-[#0F172A] p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100 font-display">
                Log Live Ordnance Strike or Deploy 3D Unit Fix
              </h2>
              <button
                type="button"
                onClick={() => setIsReportModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleLogNewReport} className="space-y-3.5 text-xs">
              <div className="flex items-center gap-2 p-1 bg-slate-900 rounded-md border border-slate-800">
                <button
                  type="button"
                  onClick={() => setReportType('event')}
                  className={`flex-1 py-1.5 rounded font-medium transition-colors ${
                    reportType === 'event' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
                  }`}
                >
                  Ordnance Strike Sphere (10–15 min)
                </button>
                <button
                  type="button"
                  onClick={() => setReportType('asset')}
                  className={`flex-1 py-1.5 rounded font-medium transition-colors ${
                    reportType === 'asset' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
                  }`}
                >
                  3D Military Unit Fix (.glb)
                </button>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">
                  {reportType === 'event'
                    ? 'Ordnance Strike Location / Headline'
                    : 'Formation Designation'}
                </label>
                <input
                  type="text"
                  required
                  value={newDesignation}
                  onChange={(e) => setNewDesignation(e.target.value)}
                  placeholder={
                    reportType === 'event'
                      ? 'e.g. Kupiansk Rail Junction Glide-Bomb Salvo'
                      : 'e.g. USS Carney DDG-64 Last Reported Fix'
                  }
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                />
              </div>

              {reportType === 'event' ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-slate-300 mb-1">Ordnance / Munition Type</label>
                      <input
                        type="text"
                        value={newOrdnanceType}
                        onChange={(e) => setNewOrdnanceType(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-300 mb-1">Expansion (10–15m)</label>
                      <select
                        value={newDissipationMins}
                        onChange={(e) => setNewDissipationMins(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                      >
                        <option value="10">10 minutes</option>
                        <option value="12">12 minutes</option>
                        <option value="15">15 minutes</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-300 mb-1">
                        Number of Munitions (Count)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="200"
                        value={newOrdnanceCount}
                        onChange={(e) => setNewOrdnanceCount(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-300 mb-1">
                        Warhead Size / Yield per Unit (kg HE)
                      </label>
                      <input
                        type="number"
                        min="10"
                        max="5000"
                        value={newOrdnanceYieldKg}
                        onChange={(e) => setNewOrdnanceYieldKg(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Callsign</label>
                    <input
                      type="text"
                      value={newCallsign}
                      onChange={(e) => setNewCallsign(e.target.value)}
                      placeholder="CARNEY-64"
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Allegiance</label>
                    <select
                      value={newAllegiance}
                      onChange={(e) => setNewAllegiance(e.target.value as any)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                    >
                      <option value="NATO / Coalition">NATO / Coalition</option>
                      <option value="Russian Federation">Russian Federation</option>
                      <option value="PLA / China">PLA / China</option>
                      <option value="Regional / Non-State">Regional Force</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">3D glTF Model</label>
                    <select
                      value={newModelType}
                      onChange={(e) => {
                        const val = e.target.value as AssetModelType;
                        setNewModelType(val);
                        if (val === 'carrier' || val === 'destroyer') setNewDomain('Maritime');
                        else if (val === 'submarine') setNewDomain('Subsurface');
                        else if (val === 'fighter' || val === 'bomber' || val === 'awacs')
                          setNewDomain('Airspace');
                        else if (val === 'armor') setNewDomain('Ground');
                        else setNewDomain('Strategic');
                      }}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                    >
                      <option value="carrier">Aircraft Carrier (CVN)</option>
                      <option value="destroyer">Destroyer (DDG)</option>
                      <option value="submarine">Submarine (SSGN)</option>
                      <option value="fighter">Fighter Squadron</option>
                      <option value="bomber">Strategic Bomber</option>
                      <option value="awacs">AWACS / ISR</option>
                      <option value="armor">Armored Brigade</option>
                      <option value="sam">SAM Battery</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Latitude (°)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newLat}
                    onChange={(e) => setNewLat(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Longitude (°)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newLon}
                    onChange={(e) => setNewLon(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Theater</label>
                  <select
                    value={newTheater}
                    onChange={(e) => setNewTheater(e.target.value as TheaterRegion)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                  >
                    <option value="Eastern Europe & Black Sea">Eastern Europe</option>
                    <option value="Middle East & Red Sea">Middle East & Red Sea</option>
                    <option value="Indo-Pacific & Taiwan Strait">Indo-Pacific</option>
                    <option value="North Atlantic, Baltic & Arctic">Baltic & Arctic</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Public OSINT Citation Note</label>
                <textarea
                  rows={2}
                  value={newSourceNote}
                  onChange={(e) => setNewSourceNote(e.target.value)}
                  placeholder="Specify FIRMS thermal timestamp, Sentinel-2 pass, or defense release..."
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-slate-100"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsReportModalOpen(false)}
                  className="px-4 py-2 rounded-md text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300 transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Plot on Cesium Globe</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
