import { parsePagination } from './pagination';

const opts = { defaultLimit: 50, maxLimit: 200 };

function parse(query: string) {
  return parsePagination(new URLSearchParams(query), opts);
}

describe('parsePagination', () => {
  it('uses the defaults when no params are present', () => {
    expect(parse('')).toEqual({ limit: 50, offset: 0 });
  });

  it('passes through valid in-range values', () => {
    expect(parse('limit=25&offset=10')).toEqual({ limit: 25, offset: 10 });
  });

  it('clamps limit up to 1 (rejects 0 and negatives)', () => {
    expect(parse('limit=0').limit).toBe(1);
    expect(parse('limit=-5').limit).toBe(1);
  });

  it('clamps limit down to maxLimit', () => {
    expect(parse('limit=9999').limit).toBe(200);
  });

  it('truncates fractional limits toward zero before clamping', () => {
    expect(parse('limit=12.9').limit).toBe(12);
  });

  it('falls back to defaultLimit for non-numeric / infinite limit', () => {
    expect(parse('limit=abc').limit).toBe(50);
    expect(parse('limit=Infinity').limit).toBe(50);
    expect(parse('limit=NaN').limit).toBe(50);
  });

  it('floors offset at 0 for negatives', () => {
    expect(parse('offset=-100').offset).toBe(0);
  });

  it('truncates fractional offsets', () => {
    expect(parse('offset=7.8').offset).toBe(7);
  });

  it('falls back to 0 offset for non-numeric / infinite offset', () => {
    expect(parse('offset=xyz').offset).toBe(0);
    expect(parse('offset=Infinity').offset).toBe(0);
  });

  it('treats an empty-string param as present-but-zero, then clamps', () => {
    // URLSearchParams('limit=') yields '' which Number('') === 0 → clamps to 1.
    expect(parse('limit=').limit).toBe(1);
    // Number('') === 0 for offset stays 0.
    expect(parse('offset=').offset).toBe(0);
  });
});
