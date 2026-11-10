// =========================================================
// 1. หมวดหมู่ย่อยของน้ำเสีย (Contamination Sub-types)
// =========================================================
export const CONTAMINATION_TYPES = {
    sewage_overflow: 'น้ำท่วมปนน้ำเสียจากท่อระบาย',
    chemical_oil: 'น้ำมันหรือสารเคมีรั่วไหล/โรงงานลักลอบปล่อย',
    waste_odor: 'ขยะหมักหมมและกลิ่นเหม็นเน่า',
    treatment_failure: 'ระบบบำบัดน้ำเสียหรือสถานีสูบน้ำเสียขัดข้อง',
    tap_water_unsafe: 'น้ำประปาขุ่น มีกลิ่น หรือไม่ปลอดภัย'
};

// =========================================================
// 2. ตัวกรองคำสำคัญ (Keyword Pre-Filter) ก่อนส่งให้ Claude
// ช่วยประหยัดเงินค่า API โดยตัดโพสต์ที่ไม่เกี่ยวข้องออกตั้งแต่ต้นทาง
// =========================================================
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

    // ถ้าเจอคำสำคัญชัดเจน ส่งเข้า LLM ทันที
    for (const kw of STRONG_KEYWORDS) {
        if (text.includes(kw)) {
            return { pass: true, matchType: 'strong', keyword: kw };
        }
    }

    // ถ้าเจอคำกำกวม เช่น "น้ำขุ่น" ให้ส่งให้ LLM ช่วยตัดสินบริบทตามที่ออกแบบไว้
    for (const kw of AMBIGUOUS_KEYWORDS) {
        if (text.includes(kw)) {
            return { pass: true, matchType: 'ambiguous', keyword: kw };
        }
    }

    return { pass: false, reason: 'no_keyword_match' };
}

// =========================================================
// 3. คำนวณดัชนีความรุนแรงระดับจังหวัด/อำเภอ + Time Decay
// โพสต์ใหม่มีน้ำหนักมากกว่า โพสต์เก่าค่อยๆ ลดระดับลงตามเวลา
// =========================================================
export function calculateAreaSeverityIndex(reports, halfLifeHours = 48) {
    if (!reports || reports.length === 0) return { indexScore: 0, level: 0 };

    const now = Date.now();
    let weightedSeveritySum = 0;
    let totalWeight = 0;
    const uniqueAuthors = new Set();

    for (const r of reports) {
        const postTime = new Date(r.post_created_at || r.processed_at).getTime();
        const ageHours = Math.max(0, (now - postTime) / (1000 * 60 * 60));

        // สูตร Exponential Time Decay: น้ำหนักลดลงครึ่งหนึ่งทุกๆ halfLifeHours (เช่น 48 ชม.)
        const timeWeight = Math.pow(0.5, ageHours / halfLifeHours);
        const confidenceWeight = r.confidence ?? 0.8;
        const weight = timeWeight * confidenceWeight;

        weightedSeveritySum += (r.severity || 1) * weight;
        totalWeight += weight;

        if (r.author && r.author !== 'anonymous') {
            uniqueAuthors.add(r.author);
        }
    }

    const avgSeverity = totalWeight > 0 ? weightedSeveritySum / totalWeight : 0;

    // โบนัสความน่าเชื่อถือจากจำนวนผู้รายงานที่ไม่ซ้ำกัน (Crowd Confirmation Factor)
    const confirmationBoost = Math.min(1.5, 1 + Math.log10(Math.max(1, uniqueAuthors.size)) * 0.3);

    // แปลงเป็นดัชนี 0 - 100 สำหรับระบายสีจังหวัดบน provinces.geojson
    const rawIndex = (avgSeverity / 3) * 100 * confirmationBoost * Math.min(1, totalWeight);
    const indexScore = Math.min(100, Math.round(rawIndex));

    // แปลงกลับเป็นระดับความรุนแรง 3 ระดับของอาจารย์
    let level = 1;
    if (indexScore >= 70) level = 3;      // วิกฤต (สีแดง/ม่วงเข้ม)
    else if (indexScore >= 35) level = 2; // ปานกลาง (สีส้ม)

    return {
        indexScore,
        level,
        reportCount: reports.length,
        uniqueReporters: uniqueAuthors.size
    };
}