/**
 * Shared limit/offset parsing for paginated list endpoints.
 *
 * Naive `Number(searchParams.get('limit'))` returns NaN for missing or
 * malformed input, which then poisons downstream Math.min/Math.max
 * clamps (NaN propagates) and eventually hits the DB driver as NaN.
 * Centralising the parse keeps the failure mode boring: always a clamped
 * positive integer.
 */

export interface PaginationOptions {
  defaultLimit: number;
  maxLimit: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(
  searchParams: URLSearchParams,
  opts: PaginationOptions,
): Pagination {
  const rawLimit = searchParams.get('limit');
  const rawOffset = searchParams.get('offset');
  const parsedLimit = rawLimit !== null ? Number(rawLimit) : opts.defaultLimit;
  const parsedOffset = rawOffset !== null ? Number(rawOffset) : 0;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.trunc(parsedLimit), 1), opts.maxLimit)
    : opts.defaultLimit;
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(Math.trunc(parsedOffset), 0)
    : 0;
  return { limit, offset };
}
