import { PROVINCE_CENTROIDS, findProvinceInText, shouldSendToLLM } from './taxonomy.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ฟังก์ชันแปลงชื่อตำบล/อำเภอเป็นพิกัดจริงผ่าน OpenStreetMap Nominatim (ฟรี)
export async function geocodeLocation(subdistrict, district, province) {
  if (!district && !subdistrict) {
    const fallback = PROVINCE_CENTROIDS?.[province];
    return fallback ? { lat: fallback.lat, lng: fallback.lng, geocode_precision: 'province' } : null;
  }

  try {
    const queryParts = [subdistrict, district, province, 'ประเทศไทย'].filter(Boolean);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(queryParts.join(' '))}&limit=1`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'WaterWarningResearchDemo/1.0' }
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          geocode_precision: subdistrict ? 'subdistrict' : 'district'
        };
      }
    }
  } catch (err) {
    console.warn(`[Geocoding Error] ${err.message}`);
  }

  const fallback = PROVINCE_CENTROIDS?.[province];
  return fallback ? { lat: fallback.lat, lng: fallback.lng, geocode_precision: 'province_fallback' } : null;
}

const SYSTEM_INSTRUCTION = `
คุณเป็นระบบ AI ผู้เชี่ยวชาญด้านการวิเคราะห์รายงานภัยพิบัติทางน้ำและมลพิษทางน้ำ (Water Warning System) ในประเทศไทย
หน้าที่ของคุณคืออ่านข้อความโพสต์จาก Social Media และสกัดข้อมูลตามเกณฑ์ดังนี้:

1. hazard_type: "flood", "contaminated_water", หรือ "other"
2. contamination_type (ถ้าเป็นน้ำเสีย): "sewage_overflow", "chemical_oil", "waste_odor", "treatment_failure", "tap_water_unsafe", หรือ null
3. severity: 1 (เฝ้าระวัง), 2 (ปานกลาง), 3 (วิกฤต)
4. สถานที่: province (จังหวัด), district (อำเภอ), subdistrict (ตำบล), landmark_or_waterway (ชื่อคลอง/แม่น้ำ)
5. health_signals: อาการสุขภาพที่ระบุในโพสต์ เช่น ["ผื่นคัน", "แสบจมูก", "แน่นหน้าอก"]
`;

export async function extractIncidentFromPost(postText) {
  if (typeof shouldSendToLLM === 'function') {
    const filterCheck = shouldSendToLLM(postText);
    if (!filterCheck.pass) {
      return { is_relevant: false, skipped_by_filter: true };
    }
  }

  if (!GEMINI_API_KEY) {
    return fallbackExtract(postText);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `${SYSTEM_INSTRUCTION}

กรุณาสกัดข้อมูลจากข้อความโพสต์นี้:
"${postText}"

ตอบกลับเป็น JSON รูปแบบนี้เท่านั้น:
{
  "is_relevant": true,
  "hazard_type": "flood" หรือ "contaminated_water" หรือ "other",
  "contamination_type": "chemical_oil" หรือ "sewage_overflow" หรือ null,
  "severity": 1 หรือ 2 หรือ 3,
  "urgency": "low" หรือ "medium" หรือ "high" หรือ "critical",
  "confidence": 0.85,
  "summary": "สรุปสั้นๆ",
  "province": "ชื่อจังหวัด",
  "district": "ชื่ออำเภอ หรือ null",
  "subdistrict": "ชื่อตำบล หรือ null",
  "landmark_or_waterway": "ชื่อคลอง/แม่น้ำ หรือ null",
  "health_signals": ["..."]
}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    if (!response.ok) {
      return fallbackExtract(postText);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const result = JSON.parse(rawText);

    if (!result.is_relevant || result.hazard_type === 'other') {
      return { is_relevant: false };
    }

    const coords = await geocodeLocation(result.subdistrict, result.district, result.province);

    return {
      ...result,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      geocode_precision: coords?.geocode_precision ?? 'none'
    };
  } catch (err) {
    return fallbackExtract(postText);
  }
}

function fallbackExtract(text) {
  const isWaste = /น้ำเสีย|น้ำเน่า|น้ำดำ|สารเคมี|กากอุตสาหกรรม|ขยะพิษ|ปลาตาย|กลิ่นเหม็น|ปนเปื้อน|คราบน้ำมัน/.test(text);
  const hazard_type = isWaste ? 'contaminated_water' : 'flood';
  let severity = 1;
  if (/วิกฤต|สารพิษ|ตายเกลื่อน|โลหะหนัก|โรงงาน|เสียชีวิต/.test(text)) severity = 3;
  else if (/เน่าเหม็น|น้ำดำ|ท่วมขัง|ผื่นขึ้น/.test(text)) severity = 2;

  const detected = findProvinceInText(text);
  const province = detected ? detected.th : 'ปราจีนบุรี';
  const coords = PROVINCE_CENTROIDS[province] || { lat: 13.7563, lng: 100.5018 };

  return {
    is_relevant: true,
    hazard_type,
    severity,
    urgency: severity === 3 ? 'critical' : 'medium',
    confidence: 0.8,
    province,
    lat: coords.lat,
    lng: coords.lng,
    summary: text.substring(0, 100) + '...',
    health_signals: []
  };
}

// ฟังก์ชันรองรับ pipeline.js เดิม เพื่อไม่ให้ติด Error
export async function extractPending() {
  return { extracted: 0 };
}