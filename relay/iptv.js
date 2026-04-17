// Playlist / XMLTV generation for IPTV clients (Dispatcharr, VLC, etc.).
// Pure functions only — the HTTP layer is responsible for headers + request
// inspection.

function escapeXML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatXMLTVDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    " +0000"
  );
}

function generateXMLTV({ channelId, channelName, programmeTitle, programmeDesc, now }) {
  const ref = now || new Date();
  // Start 1h ago so "now" always falls inside a programme block.
  const start = new Date(ref.getTime() - 60 * 60 * 1000);

  let programmes = "";
  for (let i = 0; i < 25; i++) {
    const pStart = new Date(start.getTime() + i * 60 * 60 * 1000);
    const pStop = new Date(start.getTime() + (i + 1) * 60 * 60 * 1000);
    programmes +=
      `  <programme start="${formatXMLTVDate(pStart)}" stop="${formatXMLTVDate(pStop)}" channel="${escapeXML(channelId)}">\n` +
      `    <title lang="en">${escapeXML(programmeTitle)}</title>\n` +
      `    <desc lang="en">${escapeXML(programmeDesc)}</desc>\n` +
      `  </programme>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="webpagestreamer">
  <channel id="${escapeXML(channelId)}">
    <display-name>${escapeXML(channelName)}</display-name>
  </channel>
${programmes}</tv>
`;
}

function deriveStreamURL({ overrideUrl, hostHeader, format, udpOutput, httpOutput, httpPort }) {
  if (overrideUrl) return overrideUrl;

  const host = hostHeader || `localhost:${httpPort}`;

  if (format === "hls") {
    return `http://${host}/stream/stream.m3u8`;
  }
  if (udpOutput && udpOutput.startsWith("udp://")) {
    const parsed = new URL(udpOutput);
    return `udp://@${parsed.hostname}:${parsed.port}`;
  }
  if (httpOutput) {
    return `http://${host}/stream.ts`;
  }
  return "";
}

function generateM3U(opts) {
  const streamUrl = deriveStreamURL(opts);
  const { channelId, channelName } = opts;
  return `#EXTM3U
#EXTINF:-1 tvg-id="${channelId}" tvg-name="${channelName}" group-title="${channelName}",${channelName}
${streamUrl}
`;
}

module.exports = { escapeXML, formatXMLTVDate, generateXMLTV, generateM3U, deriveStreamURL };
