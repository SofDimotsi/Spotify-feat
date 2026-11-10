const http = require("http");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 3000;
const APP_FILE = path.join(__dirname, "app.html");
const DATA_FILE = path.join(__dirname, "presence-store.json");
const CHAT_DATA_FILE = path.join(__dirname, "chat-store.json");
const PRESENCE_TTL_MS = 5 * 60 * 1000;
const MAX_RADIUS_KM = 0.3;
const MAX_CHAT_DISTANCE_KM = 5;
const CHAT_MESSAGE_MAX_LENGTH = 500;
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_PING_MS = 25 * 1000;

const DEMO_LISTENERS = [
  {
    userId: "demo-listener-1",
    displayName: "Maya (Demo)",
    track: "Blinding Lights — The Weeknd",
    trackUrl: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
    profileImageUrl: createDemoAvatarDataUri("Maya", "#ff7a59", "#1db954")
  },
  {
    userId: "demo-listener-2",
    displayName: "Theo (Demo)",
    track: "Levitating — Dua Lipa",
    trackUrl: "https://open.spotify.com/track/39LLxExYz6ewLAcYrzQQyP",
    profileImageUrl: createDemoAvatarDataUri("Theo", "#6c5ce7", "#00d4ff")
  },
  {
    userId: "demo-listener-3",
    displayName: "Nina (Demo)",
    track: "Good Days — SZA",
    trackUrl: "https://open.spotify.com/track/3YJJjQPAbDT7mGpX3WtQ9A",
    profileImageUrl: createDemoAvatarDataUri("Nina", "#00b894", "#ffd166")
  },
  {
    userId: "demo-listener-4",
    displayName: "Jordan (Demo)",
    track: "As It Was — Harry Styles",
    trackUrl: "https://open.spotify.com/track/4LRPiXqCikLlN15c3yImP7",
    profileImageUrl: createDemoAvatarDataUri("Jordan", "#ff9f1c", "#2d9cdb")
  }
];

const presenceStore = new Map();
const chatStore = new Map();
const chatRequestStore = new Map();
const eventClients = new Set();
let persistenceQueue = Promise.resolve();
let chatPersistenceQueue = Promise.resolve();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode, { "Cache-Control": "no-store" });
  response.end();
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function getBearerToken(request) {
  const authHeader = request.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    const error = new Error("Missing Spotify access token");
    error.statusCode = 401;
    throw error;
  }

  return authHeader.slice("Bearer ".length).trim();
}

let spotifyRetryAt = 0;
const spotifyProfileCache = new Map();
function spotifyGet(pathname, accessToken) {
  if (Date.now() < spotifyRetryAt) {
    const error = new Error("Spotify rate limit reached. Requests are paused until retry is allowed.");
    error.statusCode = 429;
    error.retryAfter = Math.max(1, Math.ceil((spotifyRetryAt - Date.now()) / 1000));
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.spotify.com",
        path: pathname,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      },
      (response) => {
        let raw = "";

        response.on("data", (chunk) => {
          raw += chunk;
        });

        response.on("end", () => {
          let payload = null;

          if (raw) {
            try {
              payload = JSON.parse(raw);
            } catch {
              payload = { raw };
            }
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(payload);
            return;
          }

          const error = new Error(payload?.error?.message || payload?.error_description || "Spotify request failed");
          error.statusCode = response.statusCode || 500;
          if (error.statusCode === 429) {
            const seconds = Number(response.headers["retry-after"]);
            error.retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 30;
            spotifyRetryAt = Math.max(spotifyRetryAt, Date.now() + error.retryAfter * 1000);
            error.message = "Spotify rate limit reached. Requests are paused until retry is allowed.";
          }
          reject(error);
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(12000, () => request.destroy(new Error("Spotify request timed out")));
    request.end();
  });
}

function getSpotifyUser(accessToken) {
  const cached = spotifyProfileCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (spotifyProfileCache.size >= 256) spotifyProfileCache.delete(spotifyProfileCache.keys().next().value);
  const entry = { expiresAt: Date.now() + 60000 };
  entry.promise = fetchSpotifyUser(accessToken).catch(error => {
    if (spotifyProfileCache.get(accessToken) === entry) spotifyProfileCache.delete(accessToken);
    throw error;
  });
  spotifyProfileCache.set(accessToken, entry);
  return entry.promise;
}

async function fetchSpotifyUser(accessToken) {
  const profile = await spotifyGet("/v1/me", accessToken);

  return {
    id: profile.id,
    displayName: profile.display_name || profile.id,
    imageUrl: profile.images?.[0]?.url || null,
    product: profile.product || null,
    country: profile.country || null,
    email: profile.email || null,
    externalUrl: profile.external_urls?.spotify || null,
    followersCount: Number(profile.followers?.total || 0)
  };
}

function normalizeTopArtist(artist) {
  return {
    id: artist.id || null,
    name: artist.name || "Unknown artist",
    imageUrl: artist.images?.[0]?.url || null,
    externalUrl: artist.external_urls?.spotify || null,
    genres: Array.isArray(artist.genres) ? artist.genres : [],
    popularity: Number.isFinite(artist.popularity) ? artist.popularity : null
  };
}

function normalizeTopTrack(track) {
  return {
    id: track.id || null,
    name: track.name || "Unknown track",
    externalUrl: track.external_urls?.spotify || null,
    albumName: track.album?.name || null,
    albumUrl: track.album?.external_urls?.spotify || null,
    artistNames: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name).filter(Boolean) : [],
    imageUrl: track.album?.images?.[0]?.url || null,
    explicit: Boolean(track.explicit),
    popularity: Number.isFinite(track.popularity) ? track.popularity : null,
    durationMs: Number(track.duration_ms || 0)
  };
}

function pickFirstImageUrl(images) {
  return Array.isArray(images) && images.length ? images[0]?.url || null : null;
}

function normalizeRecentTrack(track) {
  return {
    id: track.id || null,
    name: track.name || "Unknown track",
    externalUrl: track.external_urls?.spotify || null,
    albumName: track.album?.name || null,
    albumUrl: track.album?.external_urls?.spotify || null,
    artistNames: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name).filter(Boolean) : [],
    imageUrl: pickFirstImageUrl(track.album?.images),
    explicit: Boolean(track.explicit),
    popularity: Number.isFinite(track.popularity) ? track.popularity : null,
    durationMs: Number(track.duration_ms || 0)
  };
}

async function fetchWithFallback(accessToken, paths) {
  for (const path of paths) {
    try {
      const result = await spotifyGet(path, accessToken);
      if (result && Array.isArray(result.items) && result.items.length) {
        return result.items;
      }
    } catch (error) {
      if (error.statusCode !== 403 && error.statusCode !== 404) {
        // Keep trying alternate ranges/endpoints when the API returns empty/unauthorized top history.
        console.warn(`Spotify fallback failed for ${path}:`, error.message);
      }
    }
  }

  return [];
}

function buildArtistFallbackFromTracks(tracks) {
  const artistMap = new Map();

  for (const track of tracks) {
    for (const artist of track.artists || []) {
      if (!artist || !artist.id) {
        continue;
      }

      if (!artistMap.has(artist.id)) {
        artistMap.set(artist.id, {
          id: artist.id,
          name: artist.name || "Unknown artist",
          imageUrl: null,
          externalUrl: artist.external_urls?.spotify || null,
          genres: [],
          popularity: null
        });
      }
    }
  }

  return [...artistMap.values()].slice(0, 5);
}

async function getSpotifyProfileBundle(accessToken) {
  const profile = await getSpotifyUser(accessToken);

  const topTrackItems = await fetchWithFallback(accessToken, [
    "/v1/me/top/tracks?limit=5&time_range=short_term",
    "/v1/me/top/tracks?limit=5&time_range=medium_term",
    "/v1/me/top/tracks?limit=5&time_range=long_term"
  ]);

  let topArtistItems = await fetchWithFallback(accessToken, [
    "/v1/me/top/artists?limit=5&time_range=short_term",
    "/v1/me/top/artists?limit=5&time_range=medium_term",
    "/v1/me/top/artists?limit=5&time_range=long_term"
  ]);

  if (!topArtistItems.length && topTrackItems.length) {
    topArtistItems = buildArtistFallbackFromTracks(topTrackItems);
  }

  const recentTracksResult = await spotifyGet("/v1/me/player/recently-played?limit=10", accessToken).catch(() => null);
  const recentTrackItems = Array.isArray(recentTracksResult?.items)
    ? recentTracksResult.items.map((item) => normalizeRecentTrack(item.track)).filter((track) => track.id || track.name)
    : [];

  return {
    ...profile,
    topArtists: topArtistItems.map(normalizeTopArtist),
    topTracks: topTrackItems.length
      ? topTrackItems.map(normalizeTopTrack)
      : recentTrackItems
  };
}

function toNumber(value, fieldName) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    const error = new Error(`Invalid ${fieldName}`);
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

function sanitizeTrack(track) {
  if (typeof track !== "string") {
    return "nothing playing right now";
  }

  const trimmed = track.trim();
  return trimmed || "nothing playing right now";
}

function sanitizeUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeChatMessage(value) {
  if (typeof value !== "string") {
    const error = new Error("Message must be text");
    error.statusCode = 400;
    throw error;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    const error = new Error("Message cannot be empty");
    error.statusCode = 400;
    throw error;
  }

  if (trimmed.length > CHAT_MESSAGE_MAX_LENGTH) {
    const error = new Error(`Message is too long (max ${CHAT_MESSAGE_MAX_LENGTH} chars)`);
    error.statusCode = 400;
    throw error;
  }

  return trimmed;
}

function normalizeChatOptIn(value) {
  return Boolean(value);
}

function getConversationKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join("::");
}

function createRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeChatStore() {
  return JSON.stringify([...chatStore.values()], null, 2);
}

async function ensureChatDataFile() {
  try {
    await fs.access(CHAT_DATA_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(CHAT_DATA_FILE, "[]\n", "utf8");
  }
}

async function loadChatStore() {
  await ensureChatDataFile();
  const raw = await fs.readFile(CHAT_DATA_FILE, "utf8");
  const items = JSON.parse(raw || "[]");

  chatStore.clear();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.conversationKey !== "string") {
      continue;
    }

    const participants = Array.isArray(item.participants) ? item.participants.filter((id) => typeof id === "string") : [];
    if (participants.length !== 2) {
      continue;
    }

    const messages = Array.isArray(item.messages)
      ? item.messages
        .filter((message) => message && typeof message.fromUserId === "string" && typeof message.toUserId === "string" && typeof message.text === "string")
        .map((message) => ({
          fromUserId: message.fromUserId,
          toUserId: message.toUserId,
          text: message.text,
          sentAt: Number(message.sentAt) || Date.now()
        }))
      : [];

    chatStore.set(item.conversationKey, {
      conversationKey: item.conversationKey,
      participants,
      messages,
      updatedAt: Number(item.updatedAt) || Date.now()
    });
  }
}

function queuePersistChatStore() {
  const snapshot = `${serializeChatStore()}\n`;
  const tempFile = `${CHAT_DATA_FILE}.tmp`;

  chatPersistenceQueue = chatPersistenceQueue
    .catch(() => {})
    .then(async () => {
      await fs.writeFile(tempFile, snapshot, "utf8");
      await fs.rename(tempFile, CHAT_DATA_FILE);
    });

  return chatPersistenceQueue;
}

function createDemoAvatarDataUri(name, backgroundColor, accentColor) {
  const initials = String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${name} demo avatar">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${backgroundColor}" />
          <stop offset="100%" stop-color="#1b1b1b" />
        </linearGradient>
        <radialGradient id="glow" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.35" />
          <stop offset="100%" stop-color="${accentColor}" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="256" height="256" rx="128" fill="url(#bg)" />
      <circle cx="88" cy="86" r="78" fill="url(#glow)" />
      <circle cx="128" cy="128" r="96" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3" />
      <circle cx="128" cy="128" r="78" fill="rgba(0,0,0,0.14)" />
      <text x="128" y="146" text-anchor="middle" font-size="74" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#ffffff">${initials}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function isDemoPresence(userId) {
  return typeof userId === "string" && userId.startsWith("demo-listener-");
}

function serializePresenceStore() {
  return JSON.stringify([...presenceStore.values()], null, 2);
}

async function ensurePresenceDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function loadPresenceStore() {
  await ensurePresenceDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  const items = JSON.parse(raw || "[]");

  presenceStore.clear();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.userId !== "string") {
      continue;
    }

    presenceStore.set(item.userId, item);
  }
}

function queuePersistPresenceStore() {
  const snapshot = `${serializePresenceStore()}\n`;
  const tempFile = `${DATA_FILE}.tmp`;

  persistenceQueue = persistenceQueue
    .catch(() => {})
    .then(async () => {
      await fs.writeFile(tempFile, snapshot, "utf8");
      await fs.rename(tempFile, DATA_FILE);
    });

  return persistenceQueue;
}

function broadcastEvent(event) {
  const message = `data: ${JSON.stringify(event)}\n\n`;

  for (const client of eventClients) {
    client.write(message);
  }
}

async function cleanupStalePresences() {
  const now = Date.now();
  let removedAny = false;

  for (const [userId, presence] of presenceStore.entries()) {
    if (now - presence.updatedAt > PRESENCE_TTL_MS) {
      presenceStore.delete(userId);
      removedAny = true;
    }
  }

  if (removedAny) {
    await queuePersistPresenceStore();
    broadcastEvent({ type: "presence-updated", activeListeners: presenceStore.size });
  }
}

async function cleanupStaleChats() {
  const now = Date.now();
  let removedAny = false;

  for (const [conversationKey, conversation] of chatStore.entries()) {
    if (now - Number(conversation.updatedAt || 0) > CHAT_TTL_MS) {
      chatStore.delete(conversationKey);
      removedAny = true;
    }
  }

  if (removedAny) {
    await queuePersistChatStore();
  }
}

function cleanupStaleChatRequests() {
  const now = Date.now();

  for (const [requestId, request] of chatRequestStore.entries()) {
    if (now - Number(request.updatedAt || request.createdAt || 0) > CHAT_TTL_MS) {
      chatRequestStore.delete(requestId);
    }
  }
}

function haversineKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(latitudeB - latitudeA);
  const deltaLng = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addOffsetToCoords(latitude, longitude, northKm, eastKm) {
  const nextLatitude = latitude + (northKm / 111);
  const longitudeDivisor = Math.max(0.1, Math.cos(latitude * Math.PI / 180) * 111);
  const nextLongitude = longitude + (eastKm / longitudeDivisor);

  return {
    latitude: nextLatitude,
    longitude: nextLongitude
  };
}

function clearDemoPresences() {
  let deletedAny = false;

  for (const [userId] of presenceStore.entries()) {
    if (isDemoPresence(userId)) {
      presenceStore.delete(userId);
      deletedAny = true;
    }
  }

  return deletedAny;
}

async function serveApp(response) {
  const html = await fs.readFile(APP_FILE, "utf8");
  sendHtml(response, 200, html);
}

function handleEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  response.write(`retry: 3000\n`);
  response.write(`data: ${JSON.stringify({ type: "ready", activeListeners: presenceStore.size })}\n\n`);

  const heartbeat = setInterval(() => {
    response.write(`: ping ${Date.now()}\n\n`);
  }, EVENT_PING_MS);

  eventClients.add(response);

  request.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

async function handleMe(request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyProfileBundle(accessToken);
  sendJson(response, 200, user);
}

async function handlePresenceUpdate(request, response) {
  const accessToken = getBearerToken(request);
  const [body, user] = await Promise.all([
    parseJsonBody(request),
    getSpotifyUser(accessToken)
  ]);

  const latitude = toNumber(body.latitude, "latitude");
  const longitude = toNumber(body.longitude, "longitude");
  const accuracy = Math.max(0, toNumber(body.accuracy ?? 0, "accuracy"));
  const track = sanitizeTrack(body.track);
  const trackUrl = sanitizeUrl(body.trackUrl);
  const artworkUrl = sanitizeUrl(body.artworkUrl);
  const chatOpen = normalizeChatOptIn(body.chatOpen);
  const updatedAt = Date.now();

  await cleanupStalePresences();

  presenceStore.set(user.id, {
    userId: user.id,
    displayName: user.displayName,
    profileImageUrl: user.imageUrl,
    latitude,
    longitude,
    accuracy,
    track,
    trackUrl,
    artworkUrl,
    chatOpen,
    updatedAt
  });

  await queuePersistPresenceStore();
  broadcastEvent({ type: "presence-updated", activeListeners: presenceStore.size, userId: user.id });

  sendJson(response, 200, {
    ok: true,
    user: {
      userId: user.id,
      displayName: user.displayName,
      profileImageUrl: user.imageUrl,
      track,
      trackUrl,
      artworkUrl,
      chatOpen,
      updatedAt
    }
  });
}

async function handlePresenceDelete(request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyUser(accessToken);
  const deleted = presenceStore.delete(user.id);

  if (deleted) {
    await queuePersistPresenceStore();
    broadcastEvent({ type: "presence-updated", activeListeners: presenceStore.size, userId: user.id });
  }

  sendEmpty(response, 204);
}

async function handleDemoSeedListeners(request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyUser(accessToken);
  const body = await parseJsonBody(request);
  const latitude = toNumber(body.latitude, "latitude");
  const longitude = toNumber(body.longitude, "longitude");
  const count = Math.min(DEMO_LISTENERS.length, Math.max(1, Math.floor(toNumber(body.count || 4, "count"))));
  const updatedAt = Date.now();
    const offsets = [
      { northKm: 0.08, eastKm: 0.06 },
      { northKm: -0.12, eastKm: 0.15 },
      { northKm: 0.15, eastKm: -0.12 },
      { northKm: -0.10, eastKm: -0.18 }
    ];

  await cleanupStalePresences();
  clearDemoPresences();

  const seededPeople = [];

  DEMO_LISTENERS.slice(0, count).forEach((listener, index) => {
    const coords = addOffsetToCoords(latitude, longitude, offsets[index].northKm, offsets[index].eastKm);
    const presence = {
      userId: listener.userId,
      displayName: listener.displayName,
      profileImageUrl: listener.profileImageUrl || null,
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: 18,
      track: listener.track,
      trackUrl: listener.trackUrl,
      artworkUrl: null,
      chatOpen: false,
      updatedAt,
      isDemo: true
    };

    presenceStore.set(listener.userId, presence);
    seededPeople.push({
      userId: presence.userId,
      displayName: presence.displayName,
      profileImageUrl: presence.profileImageUrl,
      latitude: presence.latitude,
      longitude: presence.longitude,
      track: presence.track,
      trackUrl: presence.trackUrl,
      artworkUrl: presence.artworkUrl,
      isDemo: true,
      updatedAt: presence.updatedAt,
      distanceKm: haversineKm(latitude, longitude, presence.latitude, presence.longitude),
      accuracy: presence.accuracy,
      chatOpen: Boolean(presence.chatOpen)
    });
  });

  await queuePersistPresenceStore();
  broadcastEvent({ type: "presence-updated", activeListeners: presenceStore.size, demoSeeded: true });
  sendJson(response, 200, { ok: true, seeded: count, people: seededPeople, forUserId: user.id });
}

async function handleNearbyLookup(requestUrl, request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyUser(accessToken);
  const latitude = toNumber(requestUrl.searchParams.get("latitude"), "latitude");
  const longitude = toNumber(requestUrl.searchParams.get("longitude"), "longitude");
  const radiusKm = Math.min(
    MAX_RADIUS_KM,
    Math.max(0.05, toNumber(requestUrl.searchParams.get("radiusKm") || 0.3, "radiusKm"))
  );

  await cleanupStalePresences();
  cleanupStaleChatRequests();

  const people = [...presenceStore.values()]
    .filter((presence) => presence.userId !== user.id)
    .map((presence) => ({
      userId: presence.userId,
      displayName: presence.displayName,
      profileImageUrl: presence.profileImageUrl || null,
      latitude: presence.latitude,
      longitude: presence.longitude,
      track: presence.track,
      trackUrl: presence.trackUrl || null,
      artworkUrl: presence.artworkUrl || null,
      isDemo: Boolean(presence.isDemo),
      updatedAt: presence.updatedAt,
      distanceKm: haversineKm(latitude, longitude, presence.latitude, presence.longitude),
      accuracy: presence.accuracy,
      chatOpen: Boolean(presence.chatOpen),
      chatApproved: hasAcceptedChatRequest(user.id, presence.userId)
    }))
    .filter((presence) => presence.distanceKm <= radiusKm)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 25);

  sendJson(response, 200, { people });
}

function buildChatProximityEligibility(fromUserId, toUserId) {
   const senderPresence = presenceStore.get(fromUserId);
   const recipientPresence = presenceStore.get(toUserId);

   if (!senderPresence || !recipientPresence) {
     return { allowed: false, reason: "Both listeners must be sharing nearby." };
   }

   const distanceKm = haversineKm(
    senderPresence.latitude,
    senderPresence.longitude,
    recipientPresence.latitude,
    recipientPresence.longitude
  );

  if (distanceKm > MAX_CHAT_DISTANCE_KM) {
    return { allowed: false, reason: `Messaging is limited to ${MAX_CHAT_DISTANCE_KM} km nearby.` };
  }

  return { allowed: true, reason: null, distanceKm };
}

function getPendingChatRequestBetween(userIdA, userIdB) {
  for (const request of chatRequestStore.values()) {
    if (request.status !== "pending") {
      continue;
    }

    const isSamePair =
      (request.fromUserId === userIdA && request.toUserId === userIdB) ||
      (request.fromUserId === userIdB && request.toUserId === userIdA);

    if (isSamePair) {
      return request;
    }
  }

  return null;
}

function hasAcceptedChatRequest(userIdA, userIdB) {
  const now = Date.now();

  for (const request of chatRequestStore.values()) {
    if (request.status !== "accepted") {
      continue;
    }

    const isSamePair =
      (request.fromUserId === userIdA && request.toUserId === userIdB) ||
      (request.fromUserId === userIdB && request.toUserId === userIdA);

    if (!isSamePair) {
      continue;
    }

    if (now - Number(request.updatedAt || 0) <= CHAT_TTL_MS) {
      return true;
    }
  }

  return false;
}

function getChatRequestState(viewerUserId, otherUserId) {
  const pending = getPendingChatRequestBetween(viewerUserId, otherUserId);
  if (!pending) {
    return null;
  }

  return {
    direction: pending.fromUserId === viewerUserId ? "outgoing" : "incoming",
    requestId: pending.requestId
  };
}

function buildChatEligibility(fromUserId, toUserId) {
  const proximityCheck = buildChatProximityEligibility(fromUserId, toUserId);
  if (!proximityCheck.allowed) {
    return proximityCheck;
  }

  const recipientPresence = presenceStore.get(toUserId);
  const hasApproval = hasAcceptedChatRequest(fromUserId, toUserId);

  if (!recipientPresence.chatOpen && !hasApproval) {
    const requestState = getChatRequestState(fromUserId, toUserId);
    if (requestState?.direction === "outgoing") {
      return { allowed: false, reason: "Chat request pending.", requestState };
    }
    if (requestState?.direction === "incoming") {
      return { allowed: false, reason: "You have an incoming chat request to respond to.", requestState };
    }

    return {
      allowed: false,
      reason: "This listener is not accepting messages right now. Send a request to chat.",
      requestState: null
    };
  }

  return { allowed: true, reason: null, distanceKm: proximityCheck.distanceKm };
}

async function handleChatRequestCreate(request, response) {
  const accessToken = getBearerToken(request);
  const [body, user] = await Promise.all([
    parseJsonBody(request),
    getSpotifyUser(accessToken)
  ]);

  const recipientUserId = String(body.recipientUserId || "").trim();
  if (!recipientUserId) {
    const error = new Error("Missing recipientUserId");
    error.statusCode = 400;
    throw error;
  }

  if (recipientUserId === user.id) {
    const error = new Error("Cannot request chat with yourself");
    error.statusCode = 400;
    throw error;
  }

  await cleanupStalePresences();
  cleanupStaleChatRequests();

  const proximityCheck = buildChatProximityEligibility(user.id, recipientUserId);
  if (!proximityCheck.allowed) {
    const error = new Error(proximityCheck.reason);
    error.statusCode = 403;
    throw error;
  }

  if (hasAcceptedChatRequest(user.id, recipientUserId)) {
    sendJson(response, 200, { ok: true, alreadyApproved: true });
    return;
  }

  const existingPending = getPendingChatRequestBetween(user.id, recipientUserId);
  if (existingPending) {
    sendJson(response, 200, {
      ok: true,
      request: {
        requestId: existingPending.requestId,
        status: existingPending.status,
        direction: existingPending.fromUserId === user.id ? "outgoing" : "incoming"
      }
    });
    return;
  }

  const requestId = createRequestId();
  const now = Date.now();
  const requestItem = {
    requestId,
    fromUserId: user.id,
    toUserId: recipientUserId,
    fromDisplayName: user.displayName,
    fromProfileImageUrl: user.imageUrl || null,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };

  chatRequestStore.set(requestId, requestItem);
  broadcastEvent({ type: "chat-request-updated", requestId, fromUserId: user.id, toUserId: recipientUserId });
  sendJson(response, 200, { ok: true, request: requestItem });
}

async function handleChatRequestList(request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyUser(accessToken);
  cleanupStaleChatRequests();

  const incoming = [];
  const outgoing = [];

  for (const requestItem of chatRequestStore.values()) {
    if (requestItem.status !== "pending") {
      continue;
    }

    if (requestItem.toUserId === user.id) {
      incoming.push(requestItem);
    }

    if (requestItem.fromUserId === user.id) {
      outgoing.push(requestItem);
    }
  }

  sendJson(response, 200, { incoming, outgoing });
}

async function handleChatRequestRespond(request, response) {
  const accessToken = getBearerToken(request);
  const [body, user] = await Promise.all([
    parseJsonBody(request),
    getSpotifyUser(accessToken)
  ]);

  const requestId = String(body.requestId || "").trim();
  const action = String(body.action || "").trim().toLowerCase();

  if (!requestId) {
    const error = new Error("Missing requestId");
    error.statusCode = 400;
    throw error;
  }

  if (action !== "accept" && action !== "decline") {
    const error = new Error("Action must be accept or decline");
    error.statusCode = 400;
    throw error;
  }

  cleanupStaleChatRequests();
  const requestItem = chatRequestStore.get(requestId);
  if (!requestItem || requestItem.status !== "pending") {
    const error = new Error("Chat request no longer available");
    error.statusCode = 404;
    throw error;
  }

  if (requestItem.toUserId !== user.id) {
    const error = new Error("Only the recipient can respond to this request");
    error.statusCode = 403;
    throw error;
  }

  requestItem.status = action === "accept" ? "accepted" : "declined";
  requestItem.updatedAt = Date.now();
  requestItem.respondedBy = user.id;
  chatRequestStore.set(requestId, requestItem);

  broadcastEvent({
    type: "chat-request-updated",
    requestId,
    fromUserId: requestItem.fromUserId,
    toUserId: requestItem.toUserId,
    status: requestItem.status
  });

  sendJson(response, 200, { ok: true, request: requestItem });
}

async function handleChatGet(requestUrl, request, response) {
  const accessToken = getBearerToken(request);
  const user = await getSpotifyUser(accessToken);
  const withUserId = String(requestUrl.searchParams.get("withUserId") || "").trim();

  if (!withUserId) {
    const error = new Error("Missing withUserId");
    error.statusCode = 400;
    throw error;
  }

  if (withUserId === user.id) {
    const error = new Error("Cannot chat with yourself");
    error.statusCode = 400;
    throw error;
  }

  await cleanupStalePresences();
  await cleanupStaleChats();
  cleanupStaleChatRequests();

  const conversationKey = getConversationKey(user.id, withUserId);
  const conversation = chatStore.get(conversationKey);
  const eligibility = buildChatEligibility(user.id, withUserId);

  sendJson(response, 200, {
    withUserId,
    canMessage: eligibility.allowed,
    reason: eligibility.reason,
    requestState: eligibility.requestState || getChatRequestState(user.id, withUserId),
    hasApproval: hasAcceptedChatRequest(user.id, withUserId),
    messages: Array.isArray(conversation?.messages) ? conversation.messages : []
  });
}

async function handleChatSend(request, response) {
  const accessToken = getBearerToken(request);
  const [body, user] = await Promise.all([
    parseJsonBody(request),
    getSpotifyUser(accessToken)
  ]);

  const recipientUserId = String(body.recipientUserId || "").trim();
  if (!recipientUserId) {
    const error = new Error("Missing recipientUserId");
    error.statusCode = 400;
    throw error;
  }

  if (recipientUserId === user.id) {
    const error = new Error("Cannot send messages to yourself");
    error.statusCode = 400;
    throw error;
  }

  const text = sanitizeChatMessage(body.message);

  await cleanupStalePresences();
  await cleanupStaleChats();
  cleanupStaleChatRequests();

  const eligibility = buildChatEligibility(user.id, recipientUserId);
  if (!eligibility.allowed) {
    const error = new Error(eligibility.reason);
    error.statusCode = 403;
    throw error;
  }

  const conversationKey = getConversationKey(user.id, recipientUserId);
  const conversation = chatStore.get(conversationKey) || {
    conversationKey,
    participants: [user.id, recipientUserId].sort(),
    messages: [],
    updatedAt: Date.now()
  };

  const message = {
    fromUserId: user.id,
    toUserId: recipientUserId,
    text,
    sentAt: Date.now()
  };

  conversation.messages.push(message);
  if (conversation.messages.length > 200) {
    conversation.messages = conversation.messages.slice(-200);
  }
  conversation.updatedAt = Date.now();
  chatStore.set(conversationKey, conversation);

  await queuePersistChatStore();
  sendJson(response, 200, { ok: true, message });
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/app.html")) {
      await serveApp(response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      await cleanupStalePresences();
      await cleanupStaleChats();
      sendJson(response, 200, {
        ok: true,
        activeListeners: presenceStore.size,
        connectedEventClients: eventClients.size,
        ttlSeconds: PRESENCE_TTL_MS / 1000,
        dataFile: path.basename(DATA_FILE),
        chatDataFile: path.basename(CHAT_DATA_FILE),
        activeConversations: chatStore.size
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/events") {
      handleEventStream(request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/me") {
      await handleMe(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/presence") {
      await handlePresenceUpdate(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/demo/seed-listeners") {
      await handleDemoSeedListeners(request, response);
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === "/api/presence") {
      await handlePresenceDelete(request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/nearby") {
      await handleNearbyLookup(requestUrl, request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/chat") {
      await handleChatGet(requestUrl, request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/chat/requests") {
      await handleChatRequestList(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat/request") {
      await handleChatRequestCreate(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat/request/respond") {
      await handleChatRequestRespond(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat/send") {
      await handleChatSend(request, response);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Internal server error",
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
    });
  }
}

const server = http.createServer((request, response) => {
  requestHandler(request, response).catch((error) => {
    console.error(error);

    if (!response.headersSent) {
      sendJson(response, 500, { error: "Internal server error" });
      return;
    }

    response.end();
  });
});

async function startServer() {
   await loadPresenceStore();
   await loadChatStore();
   await cleanupStalePresences();
   await cleanupStaleChats();

    server.listen(PORT, HOST, () => {
      console.log(`🎵 Spotify Buds running at http://localhost:${PORT}/app.html`);
    });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exitCode = 1;
});

