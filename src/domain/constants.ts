/**
 * 仓库坐标与边界约定（见 README“领域约定”）。
 *
 * - 坐标为 EPSG:4326 经纬度 [lng, lat]，十进制度，统一保留 COORD_DECIMALS 位小数；
 * - 所有几何判定先量化到该精度再进行，QUANTIZED_EPSILON 为量化网格上的重合容差；
 * - 边界规则：航段与区域仅在非端点处相切（顶点接触或沿边滑行）不算侵入；
 *   穿越边界（交点两侧均在多边形外）才算几何相交，交点同时给出 interior 标记；
 * - 有效时间采用左闭右开 [valid_from, valid_until)，跨午夜按自然时刻判定；
 * - 航段时间区间同样左闭右开 [enter, exit)，与有效期重叠取 max(from)/min(until)。
 */
export const COORD_DECIMALS = 7;

/** 量化后坐标（1e-7 度）上的重合容差，约等于 1 个量化网格。 */
export const QUANTIZED_EPSILON = Math.pow(10, -COORD_DECIMALS);

/** 1 国际海里 = 1852 米，航速以节（海里/小时）给出。 */
export const METERS_PER_NAUTICAL_MILE = 1852;

export const EARTH_RADIUS_METERS = 6_371_000;

export const DECISION_STATUSES = [
  "clear",
  "restricted",
  "needs_review",
  "stale",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** 几何相交类别：none 无关系 / boundary 仅相切 / interior 穿越或位于内部。 */
export const RELATIONS = ["none", "boundary", "interior"] as const;
export type Relation = (typeof RELATIONS)[number];
