import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let Database;
try {
    const sqliteMod = await import("node:sqlite");
    Database = sqliteMod.DatabaseSync;
} catch (e) {
    const bSqlite = await import("better-sqlite3");
    Database = bSqlite.default;
}

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const rawDbPath = path.join(DATA_DIR, "raw_data.sqlite");
const procDbPath = path.join(DATA_DIR, "processed_data.sqlite");
try { if (fs.existsSync(rawDbPath)) fs.unlinkSync(rawDbPath); } catch (e) { }
try { if (fs.existsSync(procDbPath)) fs.unlinkSync(procDbPath); } catch (e) { }

const rawDb = new Database(rawDbPath);
const processedDb = new Database(procDbPath);

rawDb.exec(`
  CREATE TABLE raw_posts (
    id TEXT PRIMARY KEY,
    source_file TEXT,
    source TEXT,
    author_id TEXT,
    author_name TEXT,
    author_hash TEXT,
    post_url TEXT,
    post_date TEXT,
    raw_text TEXT,
    text TEXT,
    status TEXT DEFAULT 'processed',
    is_valid INTEGER DEFAULT 1,
    filter_reason TEXT,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_posts(status);
`);

processedDb.exec(`
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    raw_id TEXT,
    post_url TEXT,
    hazard_type TEXT,
    contamination_type TEXT,
    severity INTEGER,
    urgency TEXT,
    province TEXT,
    district TEXT,
    subdistrict TEXT,
    lat REAL,
    lon REAL,
    text TEXT,
    health_signals TEXT,
    infrastructure TEXT,
    post_created_at TEXT,
    processed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ฐานข้อมูลอำเภอและพิกัดภูมิศาสตร์ (ครอบคลุม ตะวันออก + เหนือ + ใต้)
const DISTRICTS = {
    "ปราจีนบุรี": [
        { name: "กบินทร์บุรี", aliases: ["กบินทร์บุรี", "กบินทร์", "นิคมกบินทร์", "ลาดตะเคียน", "หนองกี่"], lat: 13.9961, lon: 101.7163 },
        { name: "ศรีมหาโพธิ", aliases: ["ศรีมหาโพธิ", "ศรีมหาโพธิ์", "ท่าตูม", "นิคม 304", "นิคม304", "กรอกสมบูรณ์"], lat: 13.8821, lon: 101.5173 },
        { name: "บ้านสร้าง", aliases: ["บ้านสร้าง", "บางกระเจ็ด", "บางพลวง", "คลองสารภี"], lat: 13.9877, lon: 101.2185 },
        { name: "นาดี", aliases: ["อ.นาดี", "อำเภอนาดี", "แก่งหินเพิง", "ทับลาน", "บุพราหมณ์"], lat: 14.1568, lon: 101.8897 },
        { name: "ประจันตคาม", aliases: ["ประจันตคาม", "ดงบัง"], lat: 14.1206, lon: 101.5517 },
        { name: "ศรีมโหสถ", aliases: ["ศรีมโหสถ", "โคกปีบ", "เมืองมโหสถ"], lat: 13.8864, lon: 101.4286 },
        { name: "เมืองปราจีนบุรี", aliases: ["เมืองปราจีนบุรี", "อ.เมืองปราจีน", "อำเภอเมืองปราจีนบุรี", "ดงพระราม", "หน้าเมือง"], lat: 14.0509, lon: 101.3716 }
    ],
    "ฉะเชิงเทรา": [
        { name: "แปลงยาว", aliases: ["แปลงยาว", "นิคมเกตเวย์"], lat: 13.5828, lon: 101.2858 },
        { name: "พนมสารคาม", aliases: ["พนมสารคาม", "เกาะขนุน", "เขาหินซ้อน"], lat: 13.7431, lon: 101.3456 },
        { name: "บางคล้า", aliases: ["บางคล้า", "ปากน้ำโจ้โล้"], lat: 13.7226, lon: 101.2081 },
        { name: "บางปะกง", aliases: ["บางปะกง", "ท่าข้าม"], lat: 13.5432, lon: 100.9934 },
        { name: "บ้านโพธิ์", aliases: ["บ้านโพธิ์", "คลองประเวศ"], lat: 13.5979, lon: 101.0779 },
        { name: "บางน้ำเปรี้ยว", aliases: ["บางน้ำเปรี้ยว", "ดอนฉิมพลี", "ศาลาแดง"], lat: 13.8569, lon: 101.0603 },
        { name: "สนามชัยเขต", aliases: ["สนามชัยเขต", "ทุ่งพระยา"], lat: 13.6558, lon: 101.4384 },
        { name: "ท่าตะเกียบ", aliases: ["ท่าตะเกียบ", "คลองตะเกรา"], lat: 13.4358, lon: 101.6781 },
        { name: "ราชสาส์น", aliases: ["ราชสาส์น", "ดงน้อย"], lat: 13.7825, lon: 101.2917 },
        { name: "คลองเขื่อน", aliases: ["คลองเขื่อน"], lat: 13.7917, lon: 101.1639 },
        { name: "เมืองฉะเชิงเทรา", aliases: ["เมืองฉะเชิงเทรา", "แปดริ้ว", "อ.เมืองฉะเชิงเทรา"], lat: 13.6904, lon: 101.0779 }
    ],
    "ระยอง": [
        { name: "ปลวกแดง", aliases: ["ปลวกแดง", "นิคมอิสเทิร์นซีบอร์ด", "มาบยางพร"], lat: 12.9739, lon: 101.2158 },
        { name: "นิคมพัฒนา", aliases: ["นิคมพัฒนา", "พนานิคม"], lat: 12.8256, lon: 101.1811 },
        { name: "บ้านค่าย", aliases: ["บ้านค่าย", "หนองละลอก", "ตาขัน", "วินโพรเสส"], lat: 12.7847, lon: 101.2972 },
        { name: "แกลง", aliases: ["อ.แกลง", "ย่านแกลง", "อำเภอแกลง", "ทุ่งควายกิน", "กร่ำ"], lat: 12.7786, lon: 101.6483 },
        { name: "เมืองระยอง", aliases: ["เมืองระยอง", "มาบตาพุด", "เนินพระ", "ปากน้ำระยอง", "ทับมา"], lat: 12.6814, lon: 101.2816 },
        { name: "บ้านฉาง", aliases: ["บ้านฉาง", "พลา"], lat: 12.7275, lon: 101.0569 },
        { name: "วังจันทร์", aliases: ["วังจันทร์", "ป่ายุบใน"], lat: 12.9347, lon: 101.5208 },
        { name: "เขาชะเมา", aliases: ["เขาชะเมา", "น้ำเป็น"], lat: 12.9469, lon: 101.6961 }
    ],
    "สระแก้ว": [
        { name: "เมืองสระแก้ว", aliases: ["สระแก้ว", "วังน้ำเย็น", "วัฒนานคร", "เขาฉกรรจ์", "อรัญประเทศ"], lat: 13.814, lon: 102.072 }
    ],
    // ✅ เพิ่มภาคเหนือ
    "เชียงราย": [
        { name: "แม่สาย", aliases: ["แม่สาย", "แม่น้ำสาย", "เวียงพางคำ"], lat: 20.4334, lon: 99.8805 },
        { name: "เมืองเชียงราย", aliases: ["เมืองเชียงราย", "แม่น้ำกก", "ริมกก", "รอบเวียง", "เชียงราย"], lat: 19.9072, lon: 99.8325 }
    ],
    "น่าน": [
        { name: "ปัว", aliases: ["อ.ปัว", "อำเภอปัว", "ปัว"], lat: 19.1764, lon: 100.9167 },
        { name: "เมืองน่าน", aliases: ["เมืองน่าน", "น้ำน่าน", "น่าน"], lat: 18.7831, lon: 100.7831 }
    ],
    "เชียงใหม่": [
        { name: "เมืองเชียงใหม่", aliases: ["เมืองเชียงใหม่", "แม่ปิง", "สารภี", "ช้างเผือก", "เชียงใหม่"], lat: 18.7883, lon: 98.9853 }
    ],
    // ✅ เพิ่มภาคใต้ (ภูเก็ต ป่าตอง)
    "ภูเก็ต": [
        { name: "กะทู้", aliases: ["ป่าตอง", "ซอยนาใน", "กะทู้", "หาดป่าตอง", "กะหลิม", "กมลา"], lat: 7.8986, lon: 98.2994 },
        { name: "เมืองภูเก็ต", aliases: ["ภูเก็ต", "กะรน", "หาดกะตะ"], lat: 7.8804, lon: 98.3923 }
    ],
    "กรุงเทพมหานคร": [
        { name: "ลาดกระบัง", aliases: ["ลาดกระบัง", "ร่มเกล้า", "เคหะร่มเกล้า", "หนองจอก"], lat: 13.7231, lon: 100.7831 },
        { name: "เมืองหลวง", aliases: ["กทม", "กรุงเทพ", "ดอนเมือง", "สายไหม"], lat: 13.7563, lon: 100.5018 }
    ]
};

const PROV_CENTROIDS = {
    "ปราจีนบุรี": [14.0509, 101.3716],
    "ฉะเชิงเทรา": [13.6904, 101.0779],
    "ระยอง": [12.6814, 101.2816],
    "สระแก้ว": [13.814, 102.072],
    "เชียงราย": [19.9072, 99.8325],
    "น่าน": [18.7831, 100.7831],
    "เชียงใหม่": [18.7883, 98.9853],
    "ภูเก็ต": [7.8804, 98.3923],
    "กรุงเทพมหานคร": [13.7563, 100.5018]
};

const FOREIGN_WORDS = ["เกาหลี", "กรุงโซล", "โตเกียว", "ปักกิ่ง", "สเปน", "บาเลนเซีย", "ดูไบ", "เนปาล", "บังกลาเทศ", "น้ำท่วมจีน", "น้ำท่วมประเทศจีน", "น้ำท่วมญี่ปุ่น", "น้ำท่วมเวียดนาม", "น้ำท่วมฟิลิปปินส์"];
const POLITICS_WORDS = ["ที่ประชุมสภาผู้แทน", "สส.บัญชีรายชื่อ", "ญัตติ", "สภาผู้แทนราษฎร", "อภิปรายไม่ไว้วางใจ", "โหวตนายก", "เลือกตั้งซ่อม"];
const FLUFF_WORDS = ["ทำพิซซ่า", "ดูดวง", "ซีรีส์", "ฟุตบอล", "คอนเสิร์ต", "โปรโมชั่น", "หวย", "ของพื้นฐาน ที่ทุกภาคต้องมี", "กระเป๋าฉุกเฉิน", "หมวกกันน็อก"];

function isNoise(text) {
    for (const w of FOREIGN_WORDS) if (text.includes(w)) return [true, `ข่าวต่างประเทศ (${w})`];
    for (const w of POLITICS_WORDS) if (text.includes(w)) return [true, `การเมือง/รัฐสภา (${w})`];
    for (const w of FLUFF_WORDS) if (text.includes(w)) return [true, `ข่าวเบ็ดเตล็ด (${w})`];
    return [false, ""];
}

function addJitter(lat, lon, isDistrict) {
    const spread = isDistrict ? 0.008 : 0.035;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spread;
    return [
        Number((lat + Math.sin(angle) * radius).toFixed(5)),
        Number((lon + Math.cos(angle) * radius).toFixed(5))
    ];
}

function parseCSV(content, filename) {
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const posts = [];
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(",");
        const cells = row.map(c => c.replace(/^"|"$/g, "").trim());

        let textParts = [];
        let author = "";
        let handle = "";
        let dateStr = "2026-10-25";
        let postUrl = "";

        for (const val of cells) {
            if (!val) continue;
            if (val.startsWith("https://x.com/") && val.includes("/status/") && !postUrl) {
                postUrl = val;
            } else if (val.startsWith("@") && !handle) {
                handle = val;
            } else if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/i.test(val)) {
                dateStr = `2026-10-${val.match(/\d+/)[0].padStart(2, "0")}`;
            } else if (val.startsWith("http") || /^\d+([.,]\d+)?[KM]?$/i.test(val) || /^\d+:\d+$/.test(val) || val === "Show more" || val === "·") {
                continue;
            } else {
                textParts.push(val);
            }
        }

        if (textParts.length > 0) {
            author = textParts[0];
            const fullText = textParts.length > 1 ? textParts.slice(1).join(" ") : textParts[0];
            if (fullText.length > 15) {
                posts.push({
                    id: `${filename}_${i}`,
                    file: filename,
                    author,
                    handle,
                    dateStr,
                    postUrl,
                    text: fullText
                });
            }
        }
    }
    return posts;
}

async function run() {
    console.log("🚀 กำลังเริ่มต้นกระบวนการ Data Cleaning พร้อมแมปพิกัดภาคเหนือและทั่วไทย...");

    const csvFiles = ["Pracheen.csv", "Chachoengsao.csv", "Rayong.csv", "Flood_Waste.csv"];
    let totalRaw = 0;
    let noiseFiltered = 0;
    let cleanSaved = 0;
    const seenHash = new Set();

    const insertRaw = rawDb.prepare(`
    INSERT OR REPLACE INTO raw_posts (id, source_file, source, author_id, author_name, author_hash, post_url, post_date, raw_text, text, status, is_valid, filter_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

    const insertProcessed = processedDb.prepare(`
    INSERT OR REPLACE INTO reports (id, raw_id, post_url, hazard_type, contamination_type, severity, urgency, province, district, subdistrict, lat, lon, text, health_signals, infrastructure, post_created_at, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

    for (const f of csvFiles) {
        const fPath = path.join(ROOT, f);
        if (!fs.existsSync(fPath)) continue;

        const content = fs.readFileSync(fPath, "utf8");
        const posts = parseCSV(content, f);

        for (const p of posts) {
            totalRaw++;
            const textHash = crypto.createHash("sha256").update(p.text.replace(/\s+/g, "").slice(0, 100)).digest("hex").slice(0, 16);
            const authorHash = crypto.createHash("sha256").update(p.handle || p.author).digest("hex").slice(0, 10);

            if (seenHash.has(textHash)) continue;
            seenHash.add(textHash);

            const [noise, reason] = isNoise(p.text);
            if (noise) {
                noiseFiltered++;
                insertRaw.run(p.id, f, "x", authorHash, p.author, authorHash, p.postUrl, p.dateStr, p.text, p.text, "filtered", 0, reason);
                continue;
            }

            const wasteKeywords = ["สารเคมี", "ขยะพิษ", "กากอุตสาหกรรม", "น้ำเสีย", "น้ำดำ", "เน่าเหม็น", "ลอบทิ้ง", "โลหะหนัก", "โรงงาน", "ปลาตาย", "ควันพิษ", "แคดเมียม", "สารหนู", "สารตะกั่ว", "บ่อขยะ", "ของเสีย", "กลิ่นสารเคมี"];
            const floodKeywords = ["น้ำท่วม", "น้ำหลาก", "น้ำเอ่อ", "น้ำขัง", "จม", "น้ำป่า", "พายุ", "ฝนตกหนัก", "ระบายไม่ทัน", "ระดับน้ำ", "ล้นตลิ่ง", "จมบาดาล", "น้ำป่าไหลหลาก"];

            const isWaste = wasteKeywords.some(k => p.text.includes(k));
            const isFlood = floodKeywords.some(k => p.text.includes(k));

            if (!isWaste && !isFlood) {
                noiseFiltered++;
                insertRaw.run(p.id, f, "x", authorHash, p.author, authorHash, p.postUrl, p.dateStr, p.text, p.text, "filtered", 0, "ไม่เกี่ยวกับภัยน้ำท่วม/น้ำเสีย");
                continue;
            }

            const hazardType = isWaste ? "contaminated_water" : "flood";

            let prov = null;
            let dist = null;
            let baseCoord = null;
            let isDistMatch = false;

            // 1. ตรวจสอบชื่ออำเภอ/ตำบล/ลุ่มน้ำ (ทั้งภาคตะวันออก เหนือ ใต้ กทม.)
            for (const [pName, dList] of Object.entries(DISTRICTS)) {
                for (const d of dList) {
                    if (d.aliases.some(a => p.text.includes(a))) {
                        prov = pName;
                        dist = d.name;
                        baseCoord = [d.lat, d.lon];
                        isDistMatch = true;
                        break;
                    }
                }
                if (prov) break;
            }

            // 2. ถ้าไม่เจออำเภอ ตรวจหาชื่อจังหวัด
            if (!prov) {
                for (const [pName, coord] of Object.entries(PROV_CENTROIDS)) {
                    if (p.text.includes(pName) || (pName === "ฉะเชิงเทรา" && p.text.includes("แปดริ้ว"))) {
                        prov = pName;
                        baseCoord = coord;
                        break;
                    }
                }
            }

            // 3. Fallback อิงตามชื่อไฟล์
            if (!prov) {
                if (f.includes("Pracheen")) { prov = "ปราจีนบุรี"; baseCoord = PROV_CENTROIDS["ปราจีนบุรี"]; }
                else if (f.includes("Chachoengsao")) { prov = "ฉะเชิงเทรา"; baseCoord = PROV_CENTROIDS["ฉะเชิงเทรา"]; }
                else if (f.includes("Rayong")) { prov = "ระยอง"; baseCoord = PROV_CENTROIDS["ระยอง"]; }
                else continue;
            }

            const [finalLat, finalLon] = addJitter(baseCoord[0], baseCoord[1], isDistMatch);

            const critKeywords = ["แคดเมียม", "สารหนู", "สารตะกั่ว", "ไซยาไนด์", "สารเคมีรั่ว", "แสบจมูก", "หายใจไม่ออก", "หามส่ง", "ส่งรพ", "โรงพยาบาล", "อพยพด่วน", "วิกฤต", "มิดหลังคา", "ท่วมสูงเกิน", "ตัดขาด", "ต้องการเรือ", "ผู้ป่วยติดเตียง", "จมมิด", "น้ำป่าไหลหลาก"];
            const medKeywords = ["เน่าเหม็น", "น้ำดำ", "ปลาตาย", "โรงงานปล่อย", "ลอบทิ้ง", "บ่อขยะ", "ฟองฟอด", "ท่วมบ้าน", "ท่วมสวน", "ระดับเอว", "ระดับเข่า", "สัญจรไม่ได้", "ปิดถนน", "สูญเสีย"];

            let severity = 1;
            if (critKeywords.some(k => p.text.includes(k))) severity = 3;
            else if (medKeywords.some(k => p.text.includes(k))) severity = 2;

            const healthSignals = [];
            if (p.text.includes("กลิ่น") || p.text.includes("เหม็น") || p.text.includes("แสบ")) healthSignals.push("กลิ่นสารเคมีรบกวน");
            if (p.text.includes("ปลาตาย") || p.text.includes("สัตว์น้ำ")) healthSignals.push("สัตว์น้ำตาย");
            if (p.text.includes("ป่วย") || p.text.includes("รพ") || p.text.includes("ผื่น") || p.text.includes("สารหนู")) healthSignals.push("กระทบสุขภาพ/สารเคมี");

            insertRaw.run(p.id, f, "x", authorHash, p.author, authorHash, p.postUrl, p.dateStr, p.text, p.text, "processed", 1, "ผ่านการคัดกรอง");

            insertProcessed.run(
                p.id,
                p.id,
                p.postUrl || "",
                hazardType,
                isWaste ? "industrial_waste" : "river_overflow",
                severity,
                severity === 3 ? "critical" : (severity === 2 ? "high" : "medium"),
                prov,
                dist,
                null,
                finalLat,
                finalLon,
                p.text,
                JSON.stringify(healthSignals),
                JSON.stringify([]),
                p.dateStr
            );

            cleanSaved++;
        }
    }

    console.log(`\n==============================================`);
    console.log(`✅ อัปเดตฐานข้อมูลครอบคลุมภาคเหนือและทั่วไทยเรียบร้อย!`);
    console.log(`✨ บันทึกเหตุการณ์จริงลงแผนที่ทั้งหมด ${cleanSaved} เคส`);
    console.log(`==============================================\n`);
}

run();