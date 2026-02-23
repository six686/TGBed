const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:'];

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();

  if (String(name || '').startsWith('r2:')) return 'r2';
  if (String(name || '').startsWith('s3:')) return 's3';
  if (String(name || '').startsWith('discord:')) return 'discord';
  if (String(name || '').startsWith('hf:')) return 'huggingface';
  return 'telegram';
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const raw = url.searchParams.get('limit');
  let limit = parseInt(raw || '100', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 1000) limit = 1000;

  const cursor = url.searchParams.get('cursor') || undefined;
  const prefix = url.searchParams.get('prefix') || undefined;
  const storageFilter = (url.searchParams.get('storage') || '').toLowerCase();

  const value = await env.img_url.list({ limit, cursor, prefix });

  const keysWithStorageType = (value.keys || [])
    .filter((key) => {
      if (!key?.name) return false;
      if (INVALID_PREFIXES.some((item) => key.name.startsWith(item))) return false;
      const metadata = key.metadata || {};
      return Boolean(metadata.fileName) && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
    })
    .map((key) => {
      const metadata = key.metadata || {};
      const storageType = inferStorageType(key.name, metadata);
      return {
        ...key,
        metadata: {
          ...metadata,
          storageType,
        },
      };
    });

  let filteredKeys = keysWithStorageType;
  if (storageFilter) {
    if (storageFilter === 'kv' || storageFilter === 'telegram') {
      filteredKeys = keysWithStorageType.filter((key) => key.metadata?.storageType === 'telegram');
    } else {
      filteredKeys = keysWithStorageType.filter((key) => key.metadata?.storageType === storageFilter);
    }
  }

  return new Response(
    JSON.stringify({
      ...value,
      keys: filteredKeys,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
