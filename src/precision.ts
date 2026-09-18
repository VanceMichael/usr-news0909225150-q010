/**
 * 仓库统一坐标精度与判定常量。
 *
 * 坐标精度：经度/纬度统一四舍五入到 COORD_DECIMALS=7 位小数
 * （约 1.1 厘米），所有几何比较在该精度下进行，小于该尺度的
 * 差异视为同一点，避免浮点误差把"相切"误判成"穿越"。
 *
 * 边界规则：管制区多边形为闭合环（首末点必须重合），区域
 * 包含边界本身；沿边界航行算进入（restricted），仅在顶点处
 * 单点擦过、不进入内部算相切（needs_review / boundary_tangent）。
 */
export const COORD_DECIMALS = 7;

export const COORD_EPS = Math.pow(10, -COORD_DECIMALS) / 2;

/** 角度制 1 度纬度对应的海里数（1 分 = 1 海里）。 */
export const NM_PER_DEGREE_LAT = 60;

export type LonLat = [number, number];

/** 四舍五入到约定坐标精度，消除 -0。 */
export function roundCoord(value: number): number {
  const factor = 10 ** COORD_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundPoint([lon, lat]: LonLat): LonLat {
  return [roundCoord(lon), roundCoord(lat)];
}

/** 坐标尺度的相等判定（7 位小数精度内即视为相等）。 */
export function coordEqual(a: LonLat, b: LonLat): boolean {
  return Math.abs(a[0] - b[0]) <= COORD_EPS && Math.abs(a[1] - b[1]) <= COORD_EPS;
}
