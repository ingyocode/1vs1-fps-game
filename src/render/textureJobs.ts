import * as T from './textures';

/** Every PBR texture the map needs, keyed for parallel generation in workers. */
export const PBR_JOBS: Record<string, () => T.PBRRaw> = {
  concrete: () => T.concreteWall(1024, 11),
  floor: () => T.concreteFloor(1024, 23),
  plaza: () => T.concreteFloor(1024, 29, [0.44, 0.42, 0.4]),
  epoxy: () => T.concreteFloor(1024, 37, [0.2, 0.25, 0.24]),
  asphalt: () => T.asphalt(1024, 31),
  metal: () => T.metalPanel(512, 41),
  corrRed: () => T.corrugated(1024, 53, [0.42, 0.06, 0.04]),
  corrBlue: () => T.corrugated(1024, 54, [0.04, 0.13, 0.32]),
  corrTeal: () => T.corrugated(1024, 55, [0.03, 0.26, 0.26]),
  corrOrange: () => T.corrugated(1024, 56, [0.62, 0.22, 0.03]),
  corrYellow: () => T.corrugated(1024, 57, [0.62, 0.46, 0.05]),
  corrWall: () => T.corrugated(1024, 58, [0.5, 0.52, 0.52]),
  wood: () => T.woodCrate(512, 61),
  plate: () => T.diamondPlate(512, 71),
  hazard: () => T.hazardStripes(512, 81),
};
