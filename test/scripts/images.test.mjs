import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublicHost,
  downloadImages,
  extensionForContentType,
  ipv6Groups,
  isBlockedAddress,
  saveImages,
  sniffImageType,
} from '../../scripts/lib/images.mjs';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const TEXT = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

/** Build a minimal fetch stand-in returning the given body and headers. */
function stubResponse(bytes, contentType, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** DNS stand-in: every hostname resolves to one ordinary public address. */
const PUBLIC_DNS = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };

/** Collect writes instead of touching the disk. */
function stubFs() {
  const written = new Map();
  return {
    written,
    mkdirSync() {},
    writeFileSync(file, data) {
      written.set(file, data);
    },
  };
}

test('sniffImageType recognises the four allowed formats and rejects others', () => {
  assert.equal(sniffImageType(PNG), 'png');
  assert.equal(sniffImageType(JPG), 'jpg');
  assert.equal(sniffImageType(GIF), 'gif');
  assert.equal(sniffImageType(WEBP), 'webp');
  assert.equal(sniffImageType(TEXT), '');
  assert.equal(sniffImageType(new Uint8Array()), '');
});

test('extensionForContentType ignores parameters and rejects other types', () => {
  assert.equal(extensionForContentType('image/png; charset=binary'), 'png');
  assert.equal(extensionForContentType('IMAGE/JPEG'), 'jpg');
  assert.equal(extensionForContentType('image/svg+xml'), '');
  assert.equal(extensionForContentType(null), '');
});

test('downloadImages numbers files and writes site-absolute src values', async () => {
  const files = stubFs();
  const result = await downloadImages(
    [
      { url: 'https://e.org/a.png', alt: 'Queue view' },
      { url: 'https://e.org/b', alt: '' },
    ],
    {
      destDir: '/repo/catalog/x/screenshots',
      publicPrefix: '/catalog/x/screenshots',
      altFallback: 'X — screenshot',
      dnsImpl: PUBLIC_DNS,
      fsImpl: files,
      fetchImpl: async (url) =>
        stubResponse(url.endsWith('a.png') ? PNG : JPG, url.endsWith('a.png') ? 'image/png' : 'image/jpeg'),
    }
  );

  assert.deepEqual(result.items, [
    { src: '/catalog/x/screenshots/01.png', alt: 'Queue view' },
    { src: '/catalog/x/screenshots/02.jpg', alt: 'X — screenshot' },
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    [...files.written.keys()],
    ['/repo/catalog/x/screenshots/01.png', '/repo/catalog/x/screenshots/02.jpg']
  );
});

test('downloadImages rejects a disallowed content type and a lying content type', async () => {
  const files = stubFs();
  const result = await downloadImages([{ url: 'https://e.org/a.svg' }, { url: 'https://e.org/b.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async (url) =>
      url.endsWith('.svg') ? stubResponse(TEXT, 'image/svg+xml') : stubResponse(TEXT, 'image/png'),
  });

  assert.deepEqual(result.items, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /content type/);
  assert.match(result.warnings[1], /does not look like/);
  assert.equal(files.written.size, 0);
});

test('downloadImages caps the file count and the total size', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ url: `https://e.org/${i}.png` }));
  const files = stubFs();
  const result = await downloadImages(many, {
    destDir: '/d',
    publicPrefix: '/p',
    maxFiles: 3,
    maxTotalBytes: PNG.length * 2,
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async () => stubResponse(PNG, 'image/png'),
  });

  assert.equal(result.items.length, 2);
  assert.ok(result.warnings.some((w) => /Only the first 3 images/.test(w)));
  assert.ok(result.warnings.some((w) => /add up to more than/.test(w)));
});

test('downloadImages leaves a failed URL out of the items and warns', async () => {
  const files = stubFs();
  const result = await downloadImages([{ url: 'https://e.org/gone.png', alt: 'Gone' }], {
    destDir: '/d',
    publicPrefix: '/p',
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async () => stubResponse(PNG, 'image/png', false, 404),
  });

  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /HTTP 404/);
  assert.match(result.warnings[0], /gone\.png/);
});

test('downloadImages refuses non-http URLs and returns early with no refs', async () => {
  const blocked = await downloadImages([{ url: 'file:///etc/passwd' }], {
    destDir: '/d',
    publicPrefix: '/p',
    dnsImpl: PUBLIC_DNS,
    fsImpl: stubFs(),
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });
  assert.deepEqual(blocked.items, []);
  assert.match(blocked.warnings[0], /only http\(s\)/i);

  const none = await downloadImages([], { destDir: '/d', publicPrefix: '/p' });
  assert.deepEqual(none, { items: [], warnings: [] });
});

test('isBlockedAddress covers loopback, link-local, private and multicast space', () => {
  [
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::3',
    'ff02::1',
    '::ffff:127.0.0.1',
    'nonsense',
  ].forEach((address) => assert.equal(isBlockedAddress(address), true, address));

  ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946'].forEach((address) =>
    assert.equal(isBlockedAddress(address), false, address)
  );
});

test('isBlockedAddress judges IPv6 numerically, not by its spelling', () => {
  // The URL parser rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`
  // before a hostname reaches the guard, so every spelling of a mapped,
  // compatible or NAT64 address must be caught — and public space left alone.
  [
    '::ffff:a9fe:a9fe', // 169.254.169.254 mapped, hex spelling
    '::ffff:7f00:1', //    127.0.0.1
    '::ffff:a00:5', //     10.0.0.5
    '0:0:0:0:0:ffff:169.254.169.254',
    '::169.254.169.254', // IPv4-compatible
    '::a9fe:a9fe',
    '64:ff9b::a9fe:a9fe', // NAT64
    '64:ff9b::169.254.169.254',
    '0:0:0:0:0:0:0:1',
    'FE80::1',
    'fe80::1%en0',
    'febf::1',
    'fdff:ffff::1',
    'ff05::2',
    '2001:db8::1',
  ].forEach((address) => assert.equal(isBlockedAddress(address), true, address));

  [
    '::ffff:5db8:d822', // 93.184.216.34 mapped
    '::ffff:93.184.216.34',
    '64:ff9b::5db8:d822',
    '2606:4700::6810:84e5',
    'fec0::1', // site-local is deprecated, not link-local
    'fb00::1',
  ].forEach((address) => assert.equal(isBlockedAddress(address), false, address));

  assert.deepEqual(ipv6Groups('::ffff:169.254.169.254'), [0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe]);
  assert.deepEqual(ipv6Groups('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ipv6Groups('1:2:3'), null);
  assert.equal(ipv6Groups('example.org'), null);
});

test('assertPublicHost refuses every hostile IPv6 literal the URL parser can produce', async () => {
  const never = {
    lookup: async () => {
      throw new Error('DNS should not be consulted');
    },
  };
  for (const host of [
    '[::ffff:169.254.169.254]',
    '[::ffff:a9fe:a9fe]',
    '[::ffff:127.0.0.1]',
    '[::ffff:10.0.0.5]',
    '[0:0:0:0:0:ffff:192.168.1.1]',
    '[64:ff9b::a9fe:a9fe]',
    '[::169.254.169.254]',
    '[fe80::1]',
    '[fd00::1]',
    '[ff02::1]',
    '[::]',
  ]) {
    await assert.rejects(assertPublicHost(`http://${host}/x.png`, never), /private or reserved/, host);
  }
  await assert.doesNotReject(assertPublicHost('http://[2606:4700::6810:84e5]/x.png', never));
  await assert.doesNotReject(assertPublicHost('http://[::ffff:93.184.216.34]/x.png', never));
});

test('assertPublicHost refuses private hostnames, private DNS answers and IP literals', async () => {
  const never = {
    lookup: async () => {
      throw new Error('DNS should not be consulted');
    },
  };

  await assert.rejects(assertPublicHost('http://metadata.internal/x', never), /private hostname/);
  await assert.rejects(assertPublicHost('http://db.local/x', never), /private hostname/);
  await assert.rejects(assertPublicHost('http://localhost:8080/x', never), /private hostname/);
  await assert.rejects(
    assertPublicHost('http://169.254.169.254/latest/meta-data/', never),
    /private or reserved/
  );
  await assert.rejects(assertPublicHost('http://[::1]/x', never), /private or reserved/);

  // A public name that resolves inward (DNS rebinding) is refused too, and one
  // bad address among several is enough.
  const rebind = { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.1.2.3' }] };
  await assert.rejects(assertPublicHost('https://evil.example/x', rebind), /private address 10\.1\.2\.3/);

  await assert.doesNotReject(assertPublicHost('https://example.org/x', PUBLIC_DNS));
});

test('downloadImages never requests a URL whose host resolves inward', async () => {
  const files = stubFs();
  const result = await downloadImages(
    [{ url: 'http://169.254.169.254/latest/meta-data/iam/' }, { url: 'https://intranet.example/a.png' }],
    {
      destDir: '/d',
      publicPrefix: '/p',
      dnsImpl: { lookup: async () => [{ address: '10.0.0.7' }] },
      fsImpl: files,
      fetchImpl: async () => {
        throw new Error('fetch should never be reached');
      },
    }
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /private or reserved address/);
  assert.match(result.warnings[1], /private address 10\.0\.0\.7/);
  // Nothing that looks like an HTTP status leaked into the pull request text.
  result.warnings.forEach((warning) => assert.doesNotMatch(warning, /HTTP \d/));
});

test('downloadImages re-checks every redirect hop and caps the hop count', async () => {
  const files = stubFs();
  const seen = [];
  const redirectTo = (location) => ({
    ok: false,
    status: 302,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const bounced = await downloadImages([{ url: 'https://cdn.example/a.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    // The first host is public, the host it redirects to is not.
    dnsImpl: {
      lookup: async (host) => [{ address: host === 'cdn.example' ? '93.184.216.34' : '169.254.169.254' }],
    },
    fsImpl: files,
    fetchImpl: async (url) => {
      seen.push(url);
      return redirectTo('http://metadata.example/token');
    },
  });

  assert.deepEqual(seen, ['https://cdn.example/a.png']);
  assert.deepEqual(bounced.items, []);
  assert.match(bounced.warnings[0], /private address 169\.254\.169\.254/);

  const looped = await downloadImages([{ url: 'https://cdn.example/a.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async (url) => redirectTo(`${url}/again`),
  });
  assert.match(looped.warnings[0], /redirects more than 5 times/);
});

test('downloadImages refuses a body larger than the size cap, declared or actual', async () => {
  const withLength = (bytes, length) => ({
    ok: true,
    status: 200,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return 'image/png';
        if (key === 'content-length') return length === null ? null : String(length);
        return null;
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  const lying = await downloadImages([{ url: 'https://e.org/huge.png' }, { url: 'https://e.org/liar.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    maxTotalBytes: 8,
    dnsImpl: PUBLIC_DNS,
    fsImpl: stubFs(),
    // The first declares its size honestly; the second under-reports it and is
    // still caught once the bytes are in hand.
    fetchImpl: async (url) =>
      url.endsWith('huge.png') ? withLength(PNG, 1024 * 1024) : withLength(PNG, null),
  });

  assert.deepEqual(lying.items, []);
  assert.equal(lying.warnings.length, 2);
  lying.warnings.forEach((warning) => assert.match(warning, /size cap/));
});

test('the abort timer stays armed until the body has been read', async () => {
  // A server that answers its headers instantly and then dribbles the body used
  // to hang the job: the timeout was cleared as soon as the headers arrived.
  const files = stubFs();
  const result = await downloadImages([{ url: 'https://e.org/slow.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    timeoutMs: 20,
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(PNG.buffer), 5_000);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('The operation was aborted'));
          });
        }),
    }),
  });

  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /aborted/i);
  assert.equal(files.written.size, 0);
});

test('a streamed body is cut off at the cap instead of being buffered whole', async () => {
  // `Content-Length` is optional, so the cap cannot wait for the whole body:
  // this server answers 200 with no length and then streams for ever. The read
  // has to stop within a few chunks of the cap and abort the request.
  const files = stubFs();
  let pulled = 0;
  let aborted = false;
  const CHUNK = 1024;

  const result = await downloadImages([{ url: 'https://e.org/endless.png' }], {
    destDir: '/d',
    publicPrefix: '/p',
    maxTotalBytes: 4 * CHUNK,
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
      body: {
        async *[Symbol.asyncIterator]() {
          init.signal.addEventListener('abort', () => {
            aborted = true;
          });
          for (let i = 0; i < 100_000; i += 1) {
            if (init.signal.aborted) return;
            pulled += 1;
            yield new Uint8Array(CHUNK);
          }
        },
      },
      arrayBuffer: async () => {
        throw new Error('the stream should have been read incrementally');
      },
    }),
  });

  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /size cap/);
  assert.equal(files.written.size, 0);
  // Five chunks: four fit the cap, the fifth crosses it and ends the read.
  assert.equal(pulled, 5);
  assert.equal(aborted, true);
});

test('a streamed body under the cap is reassembled byte for byte', async () => {
  const files = stubFs();
  const result = await downloadImages([{ url: 'https://e.org/ok.png', alt: 'Fine' }], {
    destDir: '/d',
    publicPrefix: '/p',
    dnsImpl: PUBLIC_DNS,
    fsImpl: files,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
      // Split across chunks, including one that lands mid-magic-number.
      body: {
        async *[Symbol.asyncIterator]() {
          yield PNG.slice(0, 3);
          yield PNG.slice(3, 6);
          yield PNG.slice(6);
        },
      },
      arrayBuffer: async () => {
        throw new Error('the stream should have been read incrementally');
      },
    }),
  });

  assert.deepEqual(result.items, [{ src: '/p/01.png', alt: 'Fine' }]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(new Uint8Array([...files.written.values()][0]), PNG);
});

// The upload path (scripts/lib/uploads.mjs, through `resolveUpload`) and the
// URL path share one copy of the checks (`saveImages`).

const SET = 'abcdefghijklmnopqrstuvwxyz';
const upload = (char, ext) => ({ set: SET, sha256: char.repeat(64), ext });

test('bytes from an upload meet exactly the checks bytes from a URL do', async () => {
  // [case, URL body + content type, upload body + reference extension, expected warning]
  const cases = [
    [
      'bytes that are not an image',
      [TEXT, 'image/png'],
      [TEXT, 'png'],
      /does not look like a PNG, JPEG, GIF or WebP/,
    ],
    [
      'a type that is not an image',
      [PNG, 'image/svg+xml'],
      [PNG, 'pdf'],
      /content type is not PNG, JPEG, GIF or WebP/,
    ],
    ['an HTML page', [TEXT, 'text/html'], [TEXT, 'pdf'], /content type is not/],
  ];
  for (const [name, [urlBytes, contentType], [uploadBytes, ext], expected] of cases) {
    const viaUrl = stubFs();
    const fromUrl = await downloadImages([{ url: 'https://e.org/x' }], {
      destDir: '/d',
      publicPrefix: '/p',
      dnsImpl: PUBLIC_DNS,
      fsImpl: viaUrl,
      fetchImpl: async () => stubResponse(urlBytes, contentType),
    });
    const viaUpload = stubFs();
    const fromUpload = await downloadImages([{ upload: upload('a', ext) }], {
      destDir: '/d',
      publicPrefix: '/p',
      fsImpl: viaUpload,
      resolveUpload: async () => uploadBytes,
      fetchImpl: () => assert.fail('an upload never goes through the URL fetcher'),
    });
    for (const [result, files] of [
      [fromUrl, viaUrl],
      [fromUpload, viaUpload],
    ]) {
      assert.deepEqual(result.items, [], name);
      assert.equal(result.warnings.length, 1, name);
      assert.match(result.warnings[0], expected, name);
      assert.equal(files.written.size, 0, name);
    }
    assert.match(fromUpload.warnings[0], /^Skipped the uploaded file `upload:/, name);
  }
});

test('an upload is held to the shared size budget, before and after it is read', async () => {
  const budgets = [];
  const files = stubFs();
  const result = await downloadImages(
    [{ url: 'https://e.org/a.png' }, { upload: upload('a', 'png') }, { upload: upload('b', 'png') }],
    {
      destDir: '/d',
      publicPrefix: '/p',
      maxTotalBytes: PNG.length * 2 - 1,
      dnsImpl: PUBLIC_DNS,
      fsImpl: files,
      fetchImpl: async () => stubResponse(PNG, 'image/png'),
      // Misbehaves: ignores the cap it is given, so the shared total check has to catch it.
      resolveUpload: async (_ref, { maxBytes }) => {
        budgets.push(maxBytes);
        return PNG;
      },
    }
  );
  assert.deepEqual(budgets, [PNG.length - 1, PNG.length - 1], 'each read is capped at what is left');
  assert.equal(result.items.length, 1);
  assert.equal(result.warnings.length, 2);
  for (const warning of result.warnings) assert.match(warning, /the images add up to more than/);
  assert.equal(files.written.size, 1);
});

test('uploads and URLs are numbered in one sequence, and only URLs reach the fetcher', async () => {
  const fetched = [];
  const resolved = [];
  const files = stubFs();
  const result = await downloadImages(
    [
      { upload: upload('a', 'png'), alt: 'Landing page' },
      { url: 'https://github.com/user-attachments/assets/b.jpg', alt: 'Queue' },
      { upload: upload('c', 'webp') },
    ],
    {
      destDir: '/d',
      publicPrefix: '/p',
      altFallback: 'X — screenshot',
      token: 'job-token',
      dnsImpl: PUBLIC_DNS,
      fsImpl: files,
      fetchImpl: async (url, init) => {
        fetched.push([url, init.headers.authorization]);
        return stubResponse(JPG, 'image/jpeg');
      },
      resolveUpload: async (...args) => {
        resolved.push(args);
        return args[0].ext === 'png' ? PNG : WEBP;
      },
    }
  );
  assert.deepEqual(result.items, [
    { src: '/p/01.png', alt: 'Landing page' },
    { src: '/p/02.jpg', alt: 'Queue' },
    { src: '/p/03.webp', alt: 'X — screenshot' },
  ]);
  assert.deepEqual(fetched, [['https://github.com/user-attachments/assets/b.jpg', 'Bearer job-token']]);
  // The resolver is handed the reference and a cap, and nothing else: no token.
  assert.deepEqual(
    resolved.map(([ref, opts]) => [ref.sha256[0], Object.keys(opts)]),
    [
      ['a', ['maxBytes']],
      ['c', ['maxBytes']],
    ]
  );
});

test('an upload the resolver cannot find is left out with the resolver’s own warning', async () => {
  const result = await downloadImages([{ upload: upload('a', 'png') }, { upload: upload('b', 'png') }], {
    destDir: '/d',
    publicPrefix: '/p',
    fsImpl: stubFs(),
    resolveUpload: async (ref) => {
      if (ref.sha256[0] === 'a') return { warning: 'It may have expired.' };
      throw new Error('the file does not match its upload reference');
    },
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.warnings[0], 'It may have expired.');
  assert.match(
    result.warnings[1],
    /^Could not download the uploaded file `upload:abcdefghijklmnopqrstuvwxyz\/b{64}\.png` \(the file does not match its upload reference\)\. Left it out/
  );
});

test('without a resolver an upload is skipped, not guessed at', async () => {
  const result = await downloadImages([{ upload: upload('a', 'png') }], {
    destDir: '/d',
    publicPrefix: '/p',
    fsImpl: stubFs(),
  });
  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /cannot be collected here/);
  assert.deepEqual(await saveImages([], { destDir: '/d', publicPrefix: '/p' }), { items: [], warnings: [] });
});
