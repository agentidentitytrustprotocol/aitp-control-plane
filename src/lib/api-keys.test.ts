import { LABEL_RE, issuerKeyIndex, labelIndex, parseApiKeys, parseIssuerKeys } from './api-keys';

describe('parseApiKeys', () => {
  it('returns no entries for unset or empty input', () => {
    expect(parseApiKeys(undefined).entries).toEqual([]);
    expect(parseApiKeys('').entries).toEqual([]);
    expect(parseApiKeys(' , ,').entries).toEqual([]);
  });

  it('parses `label:key` entries', () => {
    expect(parseApiKeys('console:abc123, playground:def456').entries).toEqual([
      { label: 'console', key: 'abc123' },
      { label: 'playground', key: 'def456' },
    ]);
  });

  it('labels bare keys unlabelled-<n> by 1-based list position', () => {
    expect(parseApiKeys('bare1,console:abc,bare3').entries).toEqual([
      { label: 'unlabelled-1', key: 'bare1' },
      { label: 'console', key: 'abc' },
      { label: 'unlabelled-3', key: 'bare3' },
    ]);
  });

  it('splits on the FIRST colon only, so a key may itself contain colons', () => {
    expect(parseApiKeys('ops:a:b:c').entries).toEqual([{ label: 'ops', key: 'a:b:c' }]);
  });

  it('treats an entry whose prefix is not a valid label as a bare key, byte for byte', () => {
    const cases = [
      ':leading-colon', // empty label
      'has space:key', // invalid char
      '-dash:key', // must start alphanumeric
      `${'x'.repeat(41)}:key`, // too long
      'label:', // empty key
      'label:   ', // whitespace-only key
    ];
    for (const raw of cases) {
      const { entries } = parseApiKeys(raw);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe(raw.trim());
      expect(entries[0]!.label).toBe('unlabelled-1');
    }
  });

  it('accepts the documented label charset', () => {
    for (const ok of ['console', 'console-2026-10', 'ops.alice', 'ci_bot', 'A1']) {
      expect(LABEL_RE.test(ok)).toBe(true);
    }
  });

  it('refuses a label that is part of a configured key, and never echoes the key', () => {
    const secret = 'Zx9fK2mQ7vLp3sR8tW1yB4nC6hJ0dG5e';
    const { entries, warnings } = parseApiKeys(`${secret.slice(0, 20)}:${secret}`);
    expect(entries).toEqual([{ label: 'unlabelled-1', key: secret }]);
    expect(warnings).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain(secret.slice(0, 20));
  });

  it('allows a short label that happens to occur inside a key', () => {
    expect(parseApiKeys('ops:xxopsxx').entries).toEqual([{ label: 'ops', key: 'xxopsxx' }]);
  });

  it('drops a duplicate key (first label wins) and warns on a duplicate label', () => {
    const dupKey = parseApiKeys('a:k1,b:k1');
    expect(dupKey.entries).toEqual([{ label: 'a', key: 'k1' }]);
    expect(dupKey.warnings).toHaveLength(1);

    const dupLabel = parseApiKeys('console:k1,console:k2');
    expect(dupLabel.entries).toHaveLength(2);
    expect(dupLabel.warnings).toHaveLength(1);
    expect(dupLabel.warnings.join('\n')).not.toMatch(/k1|k2/);
  });

  it('labelIndex maps each key to its label', () => {
    const idx = labelIndex(parseApiKeys('console:k1,k2').entries);
    expect(idx.get('k1')).toBe('console');
    expect(idx.get('k2')).toBe('unlabelled-2');
    expect(idx.get('nope')).toBeUndefined();
  });
});

describe('parseIssuerKeys', () => {
  const AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';

  it('parses label@aid=key entries', () => {
    const { entries, warnings } = parseIssuerKeys(`researcher@${AID}=k-1, writer@aid:pubkey:p256:abc=k-2`);
    expect(entries).toEqual([
      { label: 'researcher', aid: AID, key: 'k-1' },
      { label: 'writer', aid: 'aid:pubkey:p256:abc', key: 'k-2' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps everything after the first = as the key', () => {
    expect(parseIssuerKeys(`r@${AID}=a=b`).entries[0].key).toBe('a=b');
  });

  it.each([
    ['no aid', 'r=sekrit'],
    ['no key', `r@${AID}=`],
    ['no label', `@${AID}=sekrit`],
    ['not an aid', 'r@did:web:x=sekrit'],
    ['bad label', `r r@${AID}=sekrit`],
  ])('skips a malformed entry (%s) with a warning that does not echo it', (_why, raw) => {
    const { entries, warnings } = parseIssuerKeys(raw);
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('sekrit');
  });

  it('refuses a key that is also an admin key', () => {
    const { entries, warnings } = parseIssuerKeys(`r@${AID}=admin-secret`, ['admin-secret']);
    expect(entries).toEqual([]);
    expect(warnings[0]).toMatch(/also an API_KEYS key/);
  });

  it('refuses a duplicate key, keeping the first', () => {
    const { entries, warnings } = parseIssuerKeys(`a@${AID}=k,b@${AID}=k`);
    expect(entries.map((e) => e.label)).toEqual(['a']);
    expect(warnings[0]).toMatch(/duplicate key/);
  });

  it('indexes by key', () => {
    const idx = issuerKeyIndex(parseIssuerKeys(`a@${AID}=k`).entries);
    expect(idx.get('k')).toEqual({ label: 'a', aid: AID, key: 'k' });
    expect(idx.get('a')).toBeUndefined();
  });
});
