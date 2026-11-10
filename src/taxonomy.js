import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

// =========================================================================
// 1. หมวดหมู่เดิม + เพิ่มหมวดหมู่เรื่องน้ำเสีย (contaminated_water)
// =========================================================================
export const CATEGORIES = [
  "rescue_request",     // people trapped / asking to be evacuated
  "medical",            // injured, sick, need medicine or a doctor
  "shelter",            // evacuation centres, people needing a place to stay
  "supplies_needed",    // food, water, boats, sandbags, etc.
  "damage",             // houses, farms, infrastructure damaged
  "road_closure",       // roads/bridges cut, transport blocked
  "water_level",        // river/rain gauge readings, rising/falling water
  "warning",            // official or community warnings, forecasts
  "situation_update",   // general description of conditions
  "volunteer_offer",    // people/groups offering help or donations
  "contaminated_water"  // น้ำเสีย สารเคมีรั่วไหล หรือกลิ่นเหม็นเน่า (เพิ่มใหม่)
];

// ประเภทย่อยของน้ำเสีย
export const CONTAMINATION_TYPES = {
  sewage_overflow: 'น้ำท่วมปนน้ำเสียจากท่อระบาย',
  chemical_oil: 'น้ำมันหรือสารเคมีรั่วไหล/โรงงานลักลอบปล่อย',
  waste_odor: 'ขยะหมักหมมและกลิ่นเหม็นเน่า',
  treatment_failure: 'ระบบบำบัดน้ำเสียหรือสถานีสูบน้ำเสียขัดข้อง',
  tap_water_unsafe: 'น้ำประปาขุ่น มีกลิ่น หรือไม่ปลอดภัย'
};

export const URGENCY = ["low", "medium", "high", "critical"];

// =========================================================================
// 2. ข้อมูลจังหวัด และสร้าง PROVINCE_CENTROIDS อัตโนมัติสำหรับ Geocoding
// =========================================================================
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "provinces.geojson"), "utf8"));
export const PROVINCES = geo.features.map((f) => f.properties); // {code, th, en, region, lat, lon}
export const PROVINCE_NAMES = PROVINCES.map((p) => p.en).sort();

// แผนที่พิกัด { lat, lng } รองรับทั้งชื่อไทยและอังกฤษ สำหรับใช้เป็น Fallback ใน extract.js
export const PROVINCE_CENTROIDS = {};
for (const p of PROVINCES) {
  PROVINCE_CENTROIDS[p.th] = { lat: p.lat, lng: p.lon };
  PROVINCE_CENTROIDS[p.en] = { lat: p.lat, lng: p.lon };
}

const byKey = new Map();
const key = (s) => s.toLowerCase().replace(/[\s.\-]/g, "");
for (const p of PROVINCES) {
  byKey.set(key(p.en), p);
  byKey.set(key(p.th), p);
}

// Common alternate spellings / short forms
const ALIASES = {
  "กทม": "Bangkok", "กรุงเทพ": "Bangkok", "krungthep": "Bangkok",
  "ayutthaya": "Phra Nakhon Si Ayutthaya", "อยุธยา": "Phra Nakhon Si Ayutthaya",
  "korat": "Nakhon Ratchasima", "โคราช": "Nakhon Ratchasima",
  "chainat": "Chainat", "chainath": "Chainat", "chai nat": "Chainat",
  "lopburi": "Lopburi", "lop buri": "Lopburi",
  "buriram": "Buriram", "buri ram": "Buriram",
  "chonburi": "Chonburi", "chon buri": "Chonburi",
  "sisaket": "Sisaket", "si sa ket": "Sisaket",
  "nakhonsithammarat": "Nakhon Si Thammarat", "นครศรีฯ": "Nakhon Si Thammarat",
  "hatyai": "Songkhla", "หาดใหญ่": "Songkhla",
  "maesai": "Chiang Rai", "แม่สาย": "Chiang Rai",
};
for (const [a, en] of Object.entries(ALIASES)) {
  const p = PROVINCES.find((x) => x.en === en);
  if (p) {
    byKey.set(key(a), p);
    PROVINCE_CENTROIDS[a] = { lat: p.lat, lng: p.lon };
  }
}

const AMBIGUOUS = new Set(["เลย", "ตาก"]);

/** First province (or alias) mentioned anywhere in free text */
export function findProvinceInText(text) {
  const t = key(String(text));
  let best = null;
  for (const [k, p] of byKey) {
    const hit = AMBIGUOUS.has(k) ? t.includes("จ" + k) || t.includes("จังหวัด" + k) : t.includes(k);
    if (k.length >= 3 && hit && (!best || k.length > best[0].length)) best = [k, p];
  }
  return best?.[1] || null;
}

/** Map any spelling the LLM or a user gives to the canonical province record, or null. */
export function findProvince(name) {
  if (!name) return null;
  return byKey.get(key(String(name).replace(/^(จังหวัด|จ\.)/, ""))) || null;
}

// =========================================================================
// 3. Named places (สถานที่เจาะจงระดับจุดสังเกต/อำเภอ)
// =========================================================================
const placesFile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8"));
export const PLACES = placesFile.places;
const PLACE_ALIASES = placesFile.places
  .flatMap((p) => p.aliases.map((a) => ({ alias: a.toLowerCase(), place: p })))
  .sort((a, b) => (a.place.level === "landmark" ? 0 : 1) - (b.place.level === "landmark" ? 0 : 1) || b.alias.length - a.alias.length);

export function matchPlace({ location_text, text, district, province }) {
  for (const field of [location_text, text, district]) {
    const hay = (field || "").toLowerCase();
    if (!hay) continue;
    for (const { alias, place } of PLACE_ALIASES) {
      if (!hay.includes(alias)) continue;
      const prov = PROVINCES.find((p) => p.en === place.province);
      const allText = `${text || ""} ${location_text || ""}`.toLowerCase();
      const ok =
        province === place.province ||
        (!province && (place.unique || allText.includes(prov.th) || allText.includes(prov.en.toLowerCase())));
      if (ok) return place;
    }
  }
  return null;
}

// =========================================================================
// 4. ตัวกรองคำสำคัญภาษาไทย (Pre-filter) กรองโพสต์ก่อนส่งให้ LLM (ประหยัดค่า API)
// =========================================================================
const STRONG_KEYWORDS = [
  'น้ำเสีย', 'น้ำเน่า', 'น้ำดำ', 'กลิ่นเหม็น', 'เหม็นสารเคมี', 'แสบจมูก',
  'ท่อระบายล้น', 'น้ำมันรั่ว', 'สารเคมีรั่ว', 'ลักลอบปล่อย', 'ปลาตาย',
  'ปนเปื้อน', 'น้ำประปาขุ่น', 'ประปาเค็ม', 'น้ำเปลี่ยนสี', 'ฟองขาว',
  'น้ำท่วม', 'น้ำหลาก', 'เอ่อล้น', 'ติดค้าง'
];

const AMBIGUOUS_KEYWORDS = [
  'น้ำขุ่น', 'กลิ่นแปลก', 'คันผิวหนัง', 'ผื่นขึ้น', 'คลองสีแปลก', 'สูบน้ำไม่ทัน'
];

export function shouldSendToLLM(text) {
  if (!text || text.length < 10) return { pass: false, reason: 'too_short' };

  for (const kw of STRONG_KEYWORDS) {
    if (text.includes(kw)) {
      return { pass: true, matchType: 'strong', keyword: kw };
    }
  }

  for (const kw of AMBIGUOUS_KEYWORDS) {
    if (text.includes(kw)) {
      return { pass: true, matchType: 'ambiguous', keyword: kw };
    }
  }

  return { pass: false, reason: 'no_keyword_match' };
}

// =========================================================================
// 5. คำนวณดัชนีความรุนแรงระดับจังหวัด (Time Decay + Crowd Confirmation)
// =========================================================================
export function calculateAreaSeverityIndex(reports, halfLifeHours = 48) {
  if (!reports || reports.length === 0) return { indexScore: 0, level: 0 };

  const now = Date.now();
  let weightedSeveritySum = 0;
  let totalWeight = 0;
  const uniqueAuthors = new Set();

  for (const r of reports) {
    const postTime = new Date(r.post_created_at || r.processed_at).getTime();
    const ageHours = Math.max(0, (now - postTime) / (1000 * 60 * 60));

    // Time decay: โพสต์เก่าจะลดน้ำหนักลงเรื่อยๆ
    const timeWeight = Math.pow(0.5, ageHours / halfLifeHours);
    const confidenceWeight = r.confidence ?? 0.8;
    const weight = timeWeight * confidenceWeight;

    weightedSeveritySum += (r.severity || 1) * weight;
    totalWeight += weight;

    if (r.author_masked) {
      uniqueAuthors.add(r.author_masked);
    }
  }

  const avgSeverity = totalWeight > 0 ? weightedSeveritySum / totalWeight : 0;
  const confirmationBoost = Math.min(1.5, 1 + Math.log10(Math.max(1, uniqueAuthors.size)) * 0.3);
  const rawIndex = (avgSeverity / 3) * 100 * confirmationBoost * Math.min(1, totalWeight);
  const indexScore = Math.min(100, Math.round(rawIndex));

  let level = 1;
  if (indexScore >= 70) level = 3;
  else if (indexScore >= 35) level = 2;

  return {
    indexScore,
    level,
    reportCount: reports.length,
    uniqueReporters: uniqueAuthors.size
  };
}