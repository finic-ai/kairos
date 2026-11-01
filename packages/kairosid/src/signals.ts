import { hash } from "./hash.js";

type Value = string | number | undefined;

export interface BrowserReading {
  id: string;
  parts: Record<string, Value>;
}

const FONTS = [
  "Arial Black",
  "Calibri",
  "Cambria",
  "Candara",
  "Century Gothic",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Franklin Gothic Medium",
  "Futura",
  "Garamond",
  "Geneva",
  "Gill Sans",
  "Helvetica Neue",
  "Impact",
  "Lucida Console",
  "Menlo",
  "Monaco",
  "Palatino",
  "Roboto",
  "Segoe UI",
  "Tahoma",
  "Trebuchet MS",
  "Ubuntu",
  "Verdana",
];
const GENERIC = ["monospace", "serif", "sans-serif"];
const AUDIO_MS = 500;

function safely(read: () => Value): Value {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function drawing(): Value {
  const draw = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 60;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.fillStyle = "#f60";
    context.fillRect(100, 1, 62, 20);
    context.fillStyle = "#069";
    context.font = '15px "Times New Roman"';
    context.fillText("Kairos, \u{1F603} \u2211 \u2260 \u3086", 2, 15);
    context.fillStyle = "rgba(102, 204, 0, 0.7)";
    context.font = "18pt Arial";
    context.fillText("Kairos, \u{1F603} \u2211 \u2260 \u3086", 4, 45);
    context.globalCompositeOperation = "multiply";
    context.beginPath();
    context.arc(200, 30, 20, 0, Math.PI * 2);
    context.fillStyle = "#f2f";
    context.fill();
    return hash(canvas.toDataURL());
  };
  const first = draw();
  // A browser that adds noise to each drawing gives two results: then the drawing says nothing.
  return first === draw() ? first : undefined;
}

function graphics(): Value {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return undefined;
  let vendor: unknown = gl.getParameter(gl.VENDOR);
  let renderer: unknown = gl.getParameter(gl.RENDERER);
  // Chromium and WebKit name only themselves here; the extension has the card. Firefox names the card already.
  if (/^WebKit/.test(String(renderer))) {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info) {
      vendor = gl.getParameter(info.UNMASKED_VENDOR_WEBGL);
      renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    }
  }
  return [vendor, renderer, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.SHADING_LANGUAGE_VERSION)].join(
    "|",
  );
}

function fonts(): Value {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  const width = (family: string) => {
    context.font = `72px ${family}`;
    return context.measureText("mmmmmmmmmmlli1WwQ@").width;
  };
  const plain = GENERIC.map(width);
  return FONTS.filter((font) => GENERIC.some((generic, i) => width(`"${font}", ${generic}`) !== plain[i])).join(",");
}

async function sound(): Promise<Value> {
  const Context =
    window.OfflineAudioContext ??
    (window as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Context) return undefined;
  const render = async () => {
    const context = new Context(1, 5000, 44100);
    const tone = context.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;
    tone.connect(compressor);
    compressor.connect(context.destination);
    tone.start(0);
    const samples = (await context.startRendering()).getChannelData(0);
    let total = 0;
    for (let i = 4500; i < samples.length; i++) total += Math.abs(samples[i]!);
    return Math.round(total * 1e6) / 1e6;
  };
  const first = await render();
  return first === (await render()) ? first : undefined;
}

// JavaScript engines differ in the last digits of these.
function maths(): Value {
  return [Math.tan(-1e300), Math.sinh(1), Math.acosh(1e300), Math.expm1(1), Math.cbrt(100), Math.log1p(10)].join(",");
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);

export async function readBrowser(): Promise<BrowserReading> {
  const parts: Record<string, Value> = {
    drawing: safely(drawing),
    graphics: safely(graphics),
    fonts: safely(fonts),
    sound: await within(sound(), AUDIO_MS),
    screen: safely(
      () => `${Math.max(screen.width, screen.height)}x${Math.min(screen.width, screen.height)}x${screen.colorDepth}`,
    ),
    time_zone: safely(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    languages: safely(() => navigator.languages.join(",")),
    cores: safely(() => navigator.hardwareConcurrency),
    memory: safely(() => (navigator as { deviceMemory?: number }).deviceMemory),
    platform: safely(() => navigator.platform),
    touch: safely(() => navigator.maxTouchPoints),
    vendor: safely(() => navigator.vendor),
    maths: safely(maths),
  };
  return { id: hash(JSON.stringify(parts)), parts };
}
