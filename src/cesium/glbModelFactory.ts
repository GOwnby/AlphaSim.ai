import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { AssetModelType } from '../data/osintData';

export type GlbModelDictionary = Record<AssetModelType | 'missile' | 'interceptor', string>;

let cachedDictionaryPromise: Promise<GlbModelDictionary> | null = null;

function exportGroupToGlbUrl(group: THREE.Group): Promise<string> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: 'model/gltf-binary' });
          resolve(URL.createObjectURL(blob));
        } else {
          const json = JSON.stringify(result);
          const blob = new Blob([json], { type: 'model/gltf+json' });
          resolve(URL.createObjectURL(blob));
        }
      },
      (err) => reject(err),
      { binary: true }
    );
  });
}

function buildModelMesh(type: AssetModelType | 'missile' | 'interceptor'): THREE.Group {
  const group = new THREE.Group();

  // CesiumJS glTF standard: +X forward or +Y forward depending on orientation; by default in Cesium glTF 2.0 +X is forward, +Z is up, or Three.js Y-up gets converted by GLTFExporter.
  // Let's build models in Three.js with +X forward and +Y up so they align with Cesium heading!
  const hullSteel = new THREE.MeshStandardMaterial({
    color: 0x64748b,
    metalness: 0.75,
    roughness: 0.32,
  });
  const darkDeck = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.35,
    roughness: 0.68,
  });
  const coalitionTrim = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.85,
    roughness: 0.18,
    emissive: 0x0284c7,
    emissiveIntensity: 0.35,
  });
  const warningTrim = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    metalness: 0.7,
    roughness: 0.25,
    emissive: 0xea580c,
    emissiveIntensity: 0.5,
  });

  if (type === 'carrier') {
    // 1. Main Waterline Hull (+X forward)
    const hull = new THREE.Mesh(new THREE.BoxGeometry(28, 3.8, 6.2), hullSteel);
    hull.position.set(0, 1.9, 0);
    group.add(hull);

    // 2. Angled Flight Deck Overhang
    const deck = new THREE.Mesh(new THREE.BoxGeometry(30, 0.7, 9.5), darkDeck);
    deck.position.set(0, 4.1, 0);
    group.add(deck);

    // 3. Angled Landing Strip Marking
    const runway = new THREE.Mesh(new THREE.BoxGeometry(26, 0.12, 1.2), coalitionTrim);
    runway.position.set(-1, 4.5, 1.2);
    runway.rotation.y = 0.09;
    group.add(runway);

    // 4. Starboard Island Superstructure
    const island = new THREE.Mesh(new THREE.BoxGeometry(5.5, 4.8, 2.1), hullSteel);
    island.position.set(-4.0, 6.6, -3.2);
    group.add(island);

    // 5. AN/SPY-6 Mast & Radar Array
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.7, 3.8, 8), coalitionTrim);
    mast.position.set(-4.0, 10.2, -3.2);
    group.add(mast);
  } else if (type === 'destroyer') {
    // 1. Flared Stealth Hull
    const hull = new THREE.Mesh(new THREE.BoxGeometry(22, 3.0, 4.2), hullSteel);
    hull.position.set(0, 1.5, 0);
    group.add(hull);

    // 2. Sharp Bow Taper
    const bow = new THREE.Mesh(new THREE.ConeGeometry(2.8, 6.5, 4), hullSteel);
    bow.rotation.z = -Math.PI / 2;
    bow.rotation.x = Math.PI / 4;
    bow.position.set(13.5, 1.8, 0);
    group.add(bow);

    // 3. Pyramidal Aegis / Type-055 Integrated Mast Bridge
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.5, 4.5, 4), hullSteel);
    bridge.rotation.y = Math.PI / 4;
    bridge.position.set(2.5, 5.0, 0);
    group.add(bridge);

    // 4. Fore 64-Cell VLS Battery Hatch
    const vlsFore = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.4, 2.6), coalitionTrim);
    vlsFore.position.set(8.2, 3.1, 0);
    group.add(vlsFore);

    // 5. 127mm Naval Gun Turret
    const turret = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 1.6), darkDeck);
    turret.position.set(11.2, 3.6, 0);
    group.add(turret);
  } else if (type === 'submarine') {
    // 1. Cylindrical Teardrop Hull
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(2.2, 18, 8, 16), darkDeck);
    hull.rotation.z = Math.PI / 2;
    hull.position.set(0, 2.2, 0);
    group.add(hull);

    // 2. Conning Tower Sail
    const sail = new THREE.Mesh(new THREE.BoxGeometry(4.8, 3.6, 1.3), hullSteel);
    sail.position.set(3.2, 5.2, 0);
    group.add(sail);

    // 3. Sail Dive Planes
    const planes = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 4.2), coalitionTrim);
    planes.position.set(3.4, 5.6, 0);
    group.add(planes);

    // 4. Stern Rudder Cruciform
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(2.2, 5.2, 0.3), hullSteel);
    rudder.position.set(-10.2, 2.2, 0);
    group.add(rudder);
  } else if (type === 'fighter') {
    // 1. Chined Supersonic Fuselage
    const fuselage = new THREE.Mesh(new THREE.ConeGeometry(1.8, 18, 6), hullSteel);
    fuselage.rotation.z = -Math.PI / 2;
    fuselage.position.set(0, 2.0, 0);
    group.add(fuselage);

    // 2. Swept Diamond Main Wings
    const wings = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.35, 15.0), darkDeck);
    wings.position.set(-1.5, 2.0, 0);
    group.add(wings);

    // 3. Canted Twin Vertical Tails
    const leftTail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.8, 0.3), hullSteel);
    leftTail.position.set(-6.8, 3.4, -2.0);
    leftTail.rotation.x = -0.3;
    group.add(leftTail);

    const rightTail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.8, 0.3), hullSteel);
    rightTail.position.set(-6.8, 3.4, 2.0);
    rightTail.rotation.x = 0.3;
    group.add(rightTail);

    // 4. Gold-Tinted Stealth Bubble Canopy
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), coalitionTrim);
    canopy.scale.set(2.4, 0.85, 0.9);
    canopy.position.set(3.2, 2.8, 0);
    group.add(canopy);
  } else if (type === 'bomber') {
    // Long-range strategic swept-wing heavy bomber
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 24, 12), hullSteel);
    fuselage.rotation.z = -Math.PI / 2;
    fuselage.position.set(0, 2.5, 0);
    group.add(fuselage);

    const wings = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.45, 28.0), darkDeck);
    wings.position.set(1.0, 2.8, 0);
    group.add(wings);

    const tailFin = new THREE.Mesh(new THREE.BoxGeometry(4.0, 5.2, 0.4), coalitionTrim);
    tailFin.position.set(-10.0, 5.2, 0);
    group.add(tailFin);
  } else if (type === 'awacs') {
    // 1. Airliner / Global Hawk Fuselage
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 21, 12), hullSteel);
    fuselage.rotation.z = -Math.PI / 2;
    fuselage.position.set(0, 2.2, 0);
    group.add(fuselage);

    // 2. High-Aspect Surveillance Wings
    const wings = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.4, 24.0), darkDeck);
    wings.position.set(0.5, 2.0, 0);
    group.add(wings);

    // 3. Dorsal Rotodome Struts + 360° Radar Dome
    const strut = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.4, 1.2), hullSteel);
    strut.position.set(-2.5, 4.2, 0);
    group.add(strut);

    const rotodome = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 0.9, 24), coalitionTrim);
    rotodome.position.set(-2.5, 5.6, 0);
    group.add(rotodome);
  } else if (type === 'armor') {
    // 1. Armored Hull Chassis
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(12, 2.6, 7.2), darkDeck);
    chassis.position.set(0, 1.5, 0);
    group.add(chassis);

    // 2. Composite Sloped Turret
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 2.0, 6), hullSteel);
    turret.position.set(-0.5, 3.6, 0);
    group.add(turret);

    // 3. 120mm / 155mm Main Gun Barrel
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 10.5, 8), coalitionTrim);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(5.5, 3.7, 0);
    group.add(barrel);
  } else if (type === 'sam') {
    // 1. Stabilizer Pad
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 6.8, 1.2, 8), darkDeck);
    pad.position.set(0, 0.6, 0);
    group.add(pad);

    // 2. Rotating Azimuth Turntable
    const turntable = new THREE.Mesh(new THREE.BoxGeometry(5.0, 2.8, 5.0), hullSteel);
    turntable.position.set(0, 2.4, 0);
    group.add(turntable);

    // 3. Elevated Quad-Pack Missile Canisters
    const canisterLeft = new THREE.Mesh(new THREE.BoxGeometry(9.5, 2.2, 2.0), hullSteel);
    canisterLeft.position.set(1.2, 5.2, -1.5);
    canisterLeft.rotation.z = 0.55;
    group.add(canisterLeft);

    const canisterRight = new THREE.Mesh(new THREE.BoxGeometry(9.5, 2.2, 2.0), hullSteel);
    canisterRight.position.set(1.2, 5.2, 1.5);
    canisterRight.rotation.z = 0.55;
    group.add(canisterRight);

    // 4. Phased-Array Engagement Radar Face
    const radar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 4.5), coalitionTrim);
    radar.position.set(-2.8, 5.0, 0);
    radar.rotation.z = -0.3;
    group.add(radar);
  } else {
    // Ballistic Missile or SAM Interceptor
    const mat = type === 'interceptor' ? coalitionTrim : warningTrim;
    const booster = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 9.0, 10), mat);
    booster.rotation.z = -Math.PI / 2;
    group.add(booster);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.5, 10), mat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(6.75, 0, 0);
    group.add(nose);

    const fins = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 4.2), hullSteel);
    fins.position.set(-3.2, 0, 0);
    group.add(fins);
  }

  return group;
}

export async function getOrCreateGlbModels(): Promise<GlbModelDictionary> {
  if (cachedDictionaryPromise) {
    return cachedDictionaryPromise;
  }

  cachedDictionaryPromise = (async () => {
    const keys: Array<AssetModelType | 'missile' | 'interceptor'> = [
      'carrier',
      'destroyer',
      'submarine',
      'fighter',
      'bomber',
      'awacs',
      'armor',
      'sam',
      'missile',
      'interceptor',
    ];

    const entries = await Promise.all(
      keys.map(async (k) => {
        const meshGroup = buildModelMesh(k);
        const url = await exportGroupToGlbUrl(meshGroup);
        return [k, url] as const;
      })
    );

    return Object.fromEntries(entries) as GlbModelDictionary;
  })();

  return cachedDictionaryPromise;
}
