import {
  MilitaryAsset,
  TheaterRegion,
  AssetDomain,
  AssetModelType,
  TerrainCoverType,
} from '../data/osintData';

export interface GroundingWebSource {
  title: string;
  uri: string;
}

export interface OsintDiscoveryResult {
  intelligenceBrief: string;
  discoveredAssets: MilitaryAsset[];
  groundingSources: GroundingWebSource[];
}

export interface AiTacticalCommandResult {
  tacticalAssessment: string;
  openingShotAnalysis: string;
  predictedBlueWinProbabilityPct: number;
  recommendedHitModifierBlue: number;
  recommendedHitModifierRed: number;
  spawnedAssets: MilitaryAsset[];
  groundingSources: GroundingWebSource[];
}

function classifyTheater(lat: number, lon: number): TheaterRegion {
  if (lat >= 38 && lat <= 56 && lon >= 18 && lon <= 45) {
    return 'Eastern Europe & Black Sea';
  }
  if (lat >= 10 && lat <= 38 && lon >= 30 && lon <= 65) {
    return 'Middle East & Red Sea';
  }
  if (lat >= 5 && lat <= 46 && lon >= 105 && lon <= 155) {
    return 'Indo-Pacific & Taiwan Strait';
  }
  if (lat >= 52 && lon >= -30 && lon <= 45) {
    return 'North Atlantic, Baltic & Arctic';
  }
  return 'Global Strategic Patrol';
}

export async function fetchLiveMilitaryTransponders(): Promise<MilitaryAsset[]> {
  try {
    let data: any = null;
    try {
      const serverResp = await fetch('/api/osint/live-adsb');
      if (serverResp.ok) {
        data = await serverResp.json();
      }
    } catch {
      // Fallback to direct client fetch if needed
    }

    if (!data || !Array.isArray(data.ac) || data.ac.length === 0) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      const response = await fetch('https://api.airplanes.live/v2/mil', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        data = await response.json();
      }
    }

    if (!data || !Array.isArray(data.ac)) return [];

    const validAircraft = data.ac
      .filter(
        (ac: any) =>
          typeof ac.lat === 'number' &&
          typeof ac.lon === 'number' &&
          ac.alt_baro !== 'ground' &&
          typeof ac.alt_baro === 'number' &&
          ac.alt_baro > 800
      )
      .slice(0, 55);

    const nowUtcStr = new Date().toISOString().slice(11, 19) + ' UTC';

    return validAircraft.map((ac: any, index: number): MilitaryAsset => {
      const callsign = String(ac.flight || ac.hex || `MIL-${index}`).trim();
      const typeCode = String(ac.t || 'MIL-ISR').toUpperCase();
      const altMeters = Math.round(Number(ac.alt_baro) * 0.3048);
      const gsKnots = Math.round(Number(ac.gs || 380));
      const trackDeg = Math.round(Number(ac.track || 90));
      const isHeavyIsr = /E3|E6|E2|R135|RQ4|P8|K35|KC46|C17|C130|A400|GLEX/.test(typeCode);
      const isBomber = /B52|B1|B2|TU95|TU160/.test(typeCode);

      return {
        id: `ADSB-${String(ac.hex || index).toUpperCase()}`,
        callsign,
        designation: `${callsign} (${typeCode} Live ADS-B Track)`,
        unitClass: `Live Mode-S Transponder · Type ${typeCode} · Reg ${ac.r || 'Military'}`,
        operator: ac.ownOp || 'Allied / Sovereign Military Aviation',
        allegiance: 'NATO / Coalition',
        domain: 'Airspace',
        modelType: isBomber ? 'bomber' : isHeavyIsr ? 'awacs' : 'fighter',
        theater: classifyTheater(ac.lat, ac.lon),
        lat: Number(ac.lat),
        lon: Number(ac.lon),
        altitudeMeters: altMeters,
        headingDeg: trackDeg,
        speedKnots: gsKnots,
        combatRadiusKm: isHeavyIsr ? 620 : 450,
        readinessState: 'High-Alert Patrol',
        verification: 'Live ADS-B / AIS Transponder',
        isLiveTransponder: true,
        lastReportedUtc: nowUtcStr,
        lastFixAgeLabel: `LIVE ADS-B TRANSPONDER · Hex ${String(ac.hex || '').toUpperCase()}`,
        publicSourceNote: `Real-time Mode-S ADS-B broadcast at ${(altMeters / 1000).toFixed(1)} km altitude, ${gsKnots} kts groundspeed.`,
        personnelEstimate: isHeavyIsr ? 12 : 2,
        armamentSummary: 'Active Mode-S / ADS-B Military Transponder Broadcast',
        terrainCover: 'Open Sea / Airspace',
        firstStrikeInitiative: isHeavyIsr ? 93 : 84,
        baseHitProbabilityPct: 76,
        patrolWaypoints: [
          [Number(ac.lat), Number(ac.lon)],
          [
            Math.max(-80, Math.min(80, Number(ac.lat) + Math.cos((trackDeg * Math.PI) / 180) * 1.8)),
            Math.max(-179, Math.min(179, Number(ac.lon) + Math.sin((trackDeg * Math.PI) / 180) * 1.8)),
          ],
        ],
      };
    });
  } catch {
    return [];
  }
}

export async function verifyAndDiscoverOsintAssets(
  theater: string,
  focusQuery: string,
  existingDesignations: string[]
): Promise<OsintDiscoveryResult> {
  const response = await fetch('/api/osint/verify-discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      theater,
      focusQuery,
      existingDesignations,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'OSINT Search Grounding verification failed.');
  }

  const data = await response.json();
  const rawAssets = Array.isArray(data.discoveredAssets) ? data.discoveredAssets : [];
  const nowUtc = '2026-10-27 ' + new Date().toISOString().slice(11, 16) + ' UTC';

  const mappedAssets: MilitaryAsset[] = rawAssets.map((item: any, idx: number) => {
    const lat = Math.max(-80, Math.min(80, Number(item.lat) || 25.0));
    const lon = Math.max(-179, Math.min(179, Number(item.lon) || 45.0));
    const modelType: AssetModelType = [
      'carrier',
      'destroyer',
      'submarine',
      'fighter',
      'bomber',
      'awacs',
      'armor',
      'sam',
    ].includes(item.modelType)
      ? item.modelType
      : 'destroyer';

    const domain: AssetDomain = [
      'Maritime',
      'Airspace',
      'Ground',
      'Strategic',
      'Subsurface',
    ].includes(item.domain)
      ? item.domain
      : modelType === 'fighter' || modelType === 'bomber' || modelType === 'awacs'
      ? 'Airspace'
      : modelType === 'armor'
      ? 'Ground'
      : modelType === 'sam'
      ? 'Strategic'
      : modelType === 'submarine'
      ? 'Subsurface'
      : 'Maritime';

    const terrainCover: TerrainCoverType =
      domain === 'Ground'
        ? 'Urban / Fortified Defilade'
        : domain === 'Strategic'
        ? 'Highland / Mountain Masking'
        : 'Open Sea / Airspace';

    return {
      id: `SEARCH-OSINT-${Date.now()}-${idx}`,
      callsign: String(item.callsign || `VERIFIED-${idx + 1}`).toUpperCase(),
      designation: String(item.designation || 'Search-Verified Military Unit'),
      unitClass: String(item.unitClass || 'Publicly Reported Defense Formation'),
      operator: String(item.operator || 'Defense Command'),
      allegiance: [
        'NATO / Coalition',
        'Russian Federation',
        'PLA / China',
        'Regional / Non-State',
      ].includes(item.allegiance)
        ? item.allegiance
        : 'NATO / Coalition',
      domain,
      modelType,
      theater: classifyTheater(lat, lon),
      lat,
      lon,
      altitudeMeters: domain === 'Airspace' ? Math.max(6000, Number(item.altitudeMeters) || 9000) : 0,
      headingDeg: Number(item.headingDeg) || 90,
      speedKnots: 0,
      combatRadiusKm: Math.max(80, Number(item.combatRadiusKm) || 450),
      readinessState: 'Forward Deployed',
      verification: 'Google Search Grounded OSINT',
      isLiveTransponder: false,
      lastReportedUtc: String(item.lastReportedUtc || nowUtc),
      lastFixAgeLabel: String(item.lastFixAgeLabel || 'Verified via Google Search Grounding'),
      publicSourceNote: String(
        item.publicSourceNote || 'Corroborated via Google Search Grounding of public defense feeds.'
      ),
      personnelEstimate: Number(item.personnelEstimate) || 320,
      armamentSummary: String(item.armamentSummary || 'Standard Operational Loadout'),
      terrainCover,
      firstStrikeInitiative: 82,
      baseHitProbabilityPct: 74,
      patrolWaypoints: [
        [lat, lon],
        [lat + 1.1, lon + 1.3],
        [lat - 0.9, lon + 0.5],
      ],
    };
  });

  return {
    intelligenceBrief: String(data.intelligenceBrief || ''),
    discoveredAssets: mappedAssets,
    groundingSources: Array.isArray(data.groundingSources) ? data.groundingSources : [],
  };
}

export async function runAiTacticalSimulationCommand(
  directive: string,
  cameraCenter: { lat: number; lon: number },
  activeSimulationSummary: string
): Promise<AiTacticalCommandResult> {
  const response = await fetch('/api/simulation/ai-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      directive,
      cameraCenter,
      activeSimulationSummary,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'AI Tactical Wargame Commander request failed.');
  }

  const data = await response.json();
  const rawSpawn = Array.isArray(data.spawnAssets) ? data.spawnAssets : [];
  const nowUtc = 'SIM-SPAWN ' + new Date().toISOString().slice(11, 19) + ' UTC';

  const spawnedAssets: MilitaryAsset[] = rawSpawn.map((item: any, idx: number) => {
    const lat = Math.max(-80, Math.min(80, Number(item.lat) || cameraCenter.lat));
    const lon = Math.max(-179, Math.min(179, Number(item.lon) || cameraCenter.lon));
    const modelType: AssetModelType = [
      'carrier',
      'destroyer',
      'submarine',
      'fighter',
      'bomber',
      'awacs',
      'armor',
      'sam',
    ].includes(item.modelType)
      ? item.modelType
      : 'fighter';

    const domain: AssetDomain = [
      'Maritime',
      'Airspace',
      'Ground',
      'Strategic',
      'Subsurface',
    ].includes(item.domain)
      ? item.domain
      : modelType === 'fighter' || modelType === 'bomber' || modelType === 'awacs'
      ? 'Airspace'
      : modelType === 'armor'
      ? 'Ground'
      : modelType === 'sam'
      ? 'Strategic'
      : modelType === 'submarine'
      ? 'Subsurface'
      : 'Maritime';

    return {
      id: `AI-SIM-${Date.now()}-${idx}`,
      callsign: String(item.callsign || `AI-UNIT-${idx + 1}`).toUpperCase(),
      designation: String(item.designation || 'AI Spawned Tactical Formation'),
      unitClass: String(item.unitClass || 'Simulated Combat Unit'),
      operator: String(item.operator || 'Tactical Force Command'),
      allegiance: [
        'NATO / Coalition',
        'Russian Federation',
        'PLA / China',
        'Regional / Non-State',
      ].includes(item.allegiance)
        ? item.allegiance
        : 'NATO / Coalition',
      domain,
      modelType,
      theater: classifyTheater(lat, lon),
      lat,
      lon,
      altitudeMeters: domain === 'Airspace' ? Math.max(5500, Number(item.altitudeMeters) || 9200) : 0,
      headingDeg: Number(item.headingDeg) || 90,
      speedKnots: Number(item.speedKnots) || (domain === 'Airspace' ? 440 : 24),
      combatRadiusKm: Math.max(100, Number(item.combatRadiusKm) || 520),
      readinessState: 'Combat Action',
      verification: 'Google Search Grounded OSINT',
      isLiveTransponder: false,
      lastReportedUtc: nowUtc,
      lastFixAgeLabel: 'AI Wargame Reinforcement · Active in Simulation',
      publicSourceNote: 'Deployed by AI Tactical Wargame Engine into live 3D simulation.',
      personnelEstimate: 250,
      armamentSummary: String(item.armamentSummary || 'Precision Guided Strike Loadout'),
      terrainCover:
        domain === 'Ground'
          ? 'Urban / Fortified Defilade'
          : domain === 'Strategic'
          ? 'Highland / Mountain Masking'
          : 'Open Sea / Airspace',
      firstStrikeInitiative: Math.min(
        98,
        Math.max(40, 75 + (Number(item.firstStrikeInitiativeBonus) || 12))
      ),
      baseHitProbabilityPct: Math.min(95, Math.max(35, Number(item.baseHitProbabilityPct) || 72)),
      patrolWaypoints: [
        [lat, lon],
        [lat + (Math.random() - 0.5) * 2.2, lon + (Math.random() - 0.5) * 2.2],
        [lat + (Math.random() - 0.5) * 1.6, lon + (Math.random() - 0.5) * 1.6],
      ],
    };
  });

  return {
    tacticalAssessment: String(data.tacticalAssessment || ''),
    openingShotAnalysis: String(data.openingShotAnalysis || ''),
    predictedBlueWinProbabilityPct: Number(data.predictedBlueWinProbabilityPct) || 55,
    recommendedHitModifierBlue: Number(data.recommendedHitModifierBlue) || 5,
    recommendedHitModifierRed: Number(data.recommendedHitModifierRed) || 5,
    spawnedAssets,
    groundingSources: Array.isArray(data.groundingSources) ? data.groundingSources : [],
  };
}
