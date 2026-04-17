const { test } = require("node:test");
const assert = require("node:assert/strict");
const { escapeXML, formatXMLTVDate, generateXMLTV, generateM3U } =
  require("../iptv.js");

test("escapeXML handles all five XML entities", () => {
  assert.equal(escapeXML('A & B < C > D "E"'), "A &amp; B &lt; C &gt; D &quot;E&quot;");
});

test("escapeXML returns empty string for empty input", () => {
  assert.equal(escapeXML(""), "");
});

test("formatXMLTVDate formats UTC timestamp as YYYYMMDDhhmmss +0000", () => {
  const d = new Date(Date.UTC(2026, 3, 17, 14, 5, 9)); // 2026-04-17 14:05:09 UTC
  assert.equal(formatXMLTVDate(d), "20260417140509 +0000");
});

test("generateXMLTV emits 25 hourly programme blocks with a single channel", () => {
  const xml = generateXMLTV({
    channelId: "test.1",
    channelName: "Test Channel",
    programmeTitle: "My Show",
    programmeDesc: "a & b",
    now: new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
  });
  assert.match(xml, /<channel id="test.1">/);
  assert.match(xml, /<display-name>Test Channel<\/display-name>/);
  // Description should be XML-escaped
  assert.match(xml, /<desc lang="en">a &amp; b<\/desc>/);
  // 25 programme blocks
  const programmeCount = (xml.match(/<programme /g) || []).length;
  assert.equal(programmeCount, 25);
});

test("generateM3U uses overrideUrl when provided", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "udp://example:1234",
    hostHeader: "ignored.local",
    format: "mpegts",
    udpOutput: "udp://239.0.0.1:1234",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /udp:\/\/example:1234/);
});

test("generateM3U derives stream URL from udpOutput when set", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "",
    hostHeader: "h.local:9000",
    format: "mpegts",
    udpOutput: "udp://239.0.0.1:1234",
    httpOutput: false,
    httpPort: 9000,
  });
  // UDP multicast URL is prefixed with @ so clients know to join
  assert.match(m3u, /udp:\/\/@239\.0\.0\.1:1234/);
});

test("generateM3U falls back to http://<host>/stream.ts when no UDP output and HTTP enabled", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "",
    hostHeader: "h.local:9000",
    format: "mpegts",
    udpOutput: "",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /http:\/\/h\.local:9000\/stream\.ts/);
});

test("generateM3U contains the EXTM3U header and EXTINF line", () => {
  const m3u = generateM3U({
    channelId: "c.1",
    channelName: "Chan",
    overrideUrl: "http://x/y",
    hostHeader: "h.local",
    format: "mpegts",
    udpOutput: "",
    httpOutput: true,
    httpPort: 9000,
  });
  assert.match(m3u, /^#EXTM3U/);
  assert.match(m3u, /#EXTINF:-1 tvg-id="c.1" tvg-name="Chan" group-title="Chan",Chan/);
});
