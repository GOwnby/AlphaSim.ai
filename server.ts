import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

function getGeminiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractGroundingSources(response: GenerateContentResponse): Array<{ title: string; uri: string }> {
  const chunks = (response.candidates?.[0] as any)?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const sources: Array<{ title: string; uri: string }> = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title || uri;
    if (typeof uri === 'string' && uri.startsWith('http') && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ title: String(title || 'Verified Web Source'), uri });
    }
  }
  return sources.slice(0, 8);
}

function extractJsonFromText(rawText: string): any {
  const trimmed = rawText.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Could not parse structured JSON from model response.');
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 1. Server-side Live Military ADS-B Relay (prevents browser CORS issues & harvests up to 65 live military aircraft)
  app.get('/api/osint/live-adsb', async (_req, res) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const upstream = await fetch('https://api.airplanes.live/v2/mil', {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Aegis-Global-OSINT/1.0',
        },
      });
      clearTimeout(timeout);

      if (!upstream.ok) {
        res.status(200).json({ ac: [] });
        return;
      }
      const data = await upstream.json();
      res.json(data);
    } catch {
      res.status(200).json({ ac: [] });
    }
  });

  // 2. Google Search Grounded Live OSINT Asset Verification & Discovery (gemini-3.8-flash + googleSearch)
  app.post('/api/osint/verify-discover', async (req, res) => {
    try {
      const { theater = 'Global', focusQuery = '', existingDesignations = [] } = req.body || {};
      const ai = getGeminiClient();

      const prompt = `You are a senior military OSINT intelligence verifier. Use Google Search to verify current, publicly reported military asset deployments, naval carrier strike groups, air defense batteries, air wings, and active conflict ordnance strikes for theater: "${theater}".
${focusQuery ? `Additional analyst query focus: "${focusQuery}".` : ''}
Already tracked units (avoid duplicating exact callsigns): ${existingDesignations.slice(0, 25).join(', ')}.

Search current public defense trackers (USNI News Fleet Tracker, NATO MARCOM, CENTCOM, UKMTO, Taiwan MND PLA plots, Japan Joint Staff releases, ISW frontline updates) and return a valid JSON object (no markdown outside JSON) with the following structure:
{
  "intelligenceBrief": "Concise 2-3 sentence summary of verified real-world military postures and recent movements found via Google Search.",
  "discoveredAssets": [
    {
      "callsign": "UPPERCASE-CALLSIGN",
      "designation": "Full Unit Designation (e.g. USS Carl Vinson CVN-70 CSG-1 or 31st Fighter Wing F-16CM)",
      "unitClass": "Specific platform/ship/brigade class",
      "operator": "Operating Military Branch / Country",
      "allegiance": "NATO / Coalition" | "Russian Federation" | "PLA / China" | "Regional / Non-State",
      "domain": "Maritime" | "Airspace" | "Ground" | "Strategic" | "Subsurface",
      "modelType": "carrier" | "destroyer" | "submarine" | "fighter" | "bomber" | "awacs" | "armor" | "sam",
      "theater": "Eastern Europe & Black Sea" | "Middle East & Red Sea" | "Indo-Pacific & Taiwan Strait" | "North Atlantic, Baltic & Arctic" | "Global Strategic Patrol",
      "lat": 21.45,
      "lon": 122.8,
      "altitudeMeters": 0,
      "headingDeg": 180,
      "combatRadiusKm": 550,
      "lastReportedUtc": "Recent UTC date/time or report date",
      "lastFixAgeLabel": "Verified OSINT Fix · [Source Name]",
      "publicSourceNote": "1-sentence citation of where and how this unit was publicly reported.",
      "personnelEstimate": 350,
      "armamentSummary": "Primary weapons and sensors"
    }
  ]
}
Include 4 to 6 distinct, high-confidence military assets with realistic geographic coordinates (lat, lon) matching their last reported public locations.`;

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.2,
        },
      });

      const rawText = response.text || '{}';
      const parsed = extractJsonFromText(rawText);
      const sources = extractGroundingSources(response);

      res.json({
        intelligenceBrief:
          parsed.intelligenceBrief ||
          'Google Search OSINT verification complete across public defense releases.',
        discoveredAssets: Array.isArray(parsed.discoveredAssets) ? parsed.discoveredAssets : [],
        groundingSources: sources,
      });
    } catch (error: any) {
      const msg = error?.message || 'Failed to verify OSINT assets via Gemini Search Grounding.';
      res.status(500).json({ error: msg });
    }
  });

  // 3. AI Wargame Tactical Commander & Simulation Spawner (gemini-3.8-flash + googleSearch)
  app.post('/api/simulation/ai-command', async (req, res) => {
    try {
      const {
        directive = '',
        cameraCenter = { lat: 31.5, lon: 34.5 },
        activeSimulationSummary = '',
      } = req.body || {};

      const ai = getGeminiClient();

      const prompt = `You are the AI Tactical Wargame Engine for Aegis Global OSINT.
Current 3D Globe Camera Center: Latitude ${Number(cameraCenter.lat).toFixed(2)}°, Longitude ${Number(cameraCenter.lon).toFixed(2)}°.
Current Battlefield State Summary:
${activeSimulationSummary}

User Tactical Directive / Scenario Request:
"${directive || 'Analyze the current engagement geometry, who holds the opening shot and line-of-sight advantage, and deploy a balanced reinforcement wave of Blue and Red assets near the current camera theater so they immediately engage.'}"

Use Google Search grounding to incorporate accurate weapon ranges, radar horizon characteristics, and real-world order-of-battle designations.
Remember how our 3D simulation physics engine resolves combat:
- Outcome is driven by: (1) Number of assets (salvo saturation bonus), (2) Who targets first / Opening Shot initiative (+20% hit bonus and suppresses target before return fire), (3) Terrain & Line-of-Sight (radar horizon, elevation masking, AWACS datalink), and (4) Random percentage roll to hit.

Return a valid JSON object (no markdown commentary outside JSON) with this exact structure:
{
  "tacticalAssessment": "2-3 sentence analysis of the current force ratio, Terrain/Line-of-Sight masking, and which side holds the decisive Opening Shot advantage.",
  "openingShotAnalysis": "Specific breakdown of who fires first and why (sensor reach, AWACS link, stealth, or terrain elevation).",
  "predictedBlueWinProbabilityPct": 62,
  "recommendedHitModifierBlue": 8,
  "recommendedHitModifierRed": 5,
  "spawnAssets": [
    {
      "callsign": "CALLSIGN-01",
      "designation": "Realistic Military Unit Designation",
      "unitClass": "Platform Class",
      "operator": "Military Operator",
      "allegiance": "NATO / Coalition" | "Russian Federation" | "PLA / China" | "Regional / Non-State",
      "domain": "Maritime" | "Airspace" | "Ground" | "Strategic" | "Subsurface",
      "modelType": "carrier" | "destroyer" | "submarine" | "fighter" | "bomber" | "awacs" | "armor" | "sam",
      "theater": "Eastern Europe & Black Sea" | "Middle East & Red Sea" | "Indo-Pacific & Taiwan Strait" | "North Atlantic, Baltic & Arctic",
      "lat": 32.1,
      "lon": 35.2,
      "altitudeMeters": 8500,
      "headingDeg": 90,
      "speedKnots": 420,
      "combatRadiusKm": 480,
      "armamentSummary": "Primary weapons loadout",
      "firstStrikeInitiativeBonus": 18,
      "baseHitProbabilityPct": 68
    }
  ]
}
Include 2 to 5 newly spawned military units in "spawnAssets" positioned around the active theater (${Number(cameraCenter.lat).toFixed(2)}, ${Number(cameraCenter.lon).toFixed(2)}) or the location mentioned in the user's directive so they immediately interact on the 3D globe.`;

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.35,
        },
      });

      const rawText = response.text || '{}';
      const parsed = extractJsonFromText(rawText);
      const sources = extractGroundingSources(response);

      res.json({
        tacticalAssessment:
          parsed.tacticalAssessment ||
          'Tactical engagement analyzed: Opening shot initiative and clear radar line-of-sight dominate attrition outcomes.',
        openingShotAnalysis:
          parsed.openingShotAnalysis ||
          'Airborne AWACS and long-range SAM batteries hold first-look, first-shoot priority over surface formations.',
        predictedBlueWinProbabilityPct:
          typeof parsed.predictedBlueWinProbabilityPct === 'number'
            ? parsed.predictedBlueWinProbabilityPct
            : 55,
        recommendedHitModifierBlue:
          typeof parsed.recommendedHitModifierBlue === 'number'
            ? parsed.recommendedHitModifierBlue
            : 5,
        recommendedHitModifierRed:
          typeof parsed.recommendedHitModifierRed === 'number'
            ? parsed.recommendedHitModifierRed
            : 5,
        spawnAssets: Array.isArray(parsed.spawnAssets) ? parsed.spawnAssets : [],
        groundingSources: sources,
      });
    } catch (error: any) {
      const msg = error?.message || 'Failed to run AI Tactical Wargame Commander.';
      res.status(500).json({ error: msg });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aegis Global OSINT Full-Stack Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
