import express from "express";
import path from "node:path";
import { config, ROOT } from "./config.js";

let Database;
try {
  const sqliteMod = await import("node:sqlite");
  Database = sqliteMod.DatabaseSync;
} catch (e) {
  const bSqlite = await import("better-sqlite3");
  Database = bSqlite.default;
}

const procDbPath = path.join(ROOT, "data", "processed_data.sqlite");
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/provinces.geojson", (_req, res) => {
  res.sendFile(path.join(ROOT, "data", "provinces.geojson"));
});

function getDb() {
  return new Database(procDbPath);
}

// 1. KPI ปรับตัวเลขตามช่วงเวลาสัปดาห์ที่เลือกแบบ Real-time
app.get("/api/kpi", (req, res) => {
  try {
    const db = getDb();
    const period = req.query.period;
    let dateCond = "";
    if (period === "this_week") dateCond = " AND post_created_at >= '2026-10-24'";
    else if (period === "last_week") dateCond = " AND post_created_at < '2026-10-24'";

    const totalReports = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE 1=1 ${dateCond}`).get().count;
    const criticalReports = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE severity = 3 ${dateCond}`).get().count;
    const wasteReports = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'contaminated_water' ${dateCond}`).get().count;
    const floodReports = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'flood' ${dateCond}`).get().count;

    const wasteThisWeek = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'contaminated_water' AND post_created_at >= '2026-10-24'`).get().count;
    const wasteLastWeek = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'contaminated_water' AND post_created_at < '2026-10-24'`).get().count;
    const floodThisWeek = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'flood' AND post_created_at >= '2026-10-24'`).get().count;
    const floodLastWeek = db.prepare(`SELECT COUNT(*) as count FROM reports WHERE hazard_type = 'flood' AND post_created_at < '2026-10-24'`).get().count;

    res.json({
      totalReports,
      criticalReports,
      wasteReports,
      floodReports,
      trends: { wasteThisWeek, wasteLastWeek, floodThisWeek, floodLastWeek }
    });
  } catch (err) {
    res.json({ totalReports: 0, criticalReports: 0, wasteReports: 0, floodReports: 0 });
  }
});

// 2. ดัชนีความรุนแรงและสีย้อมจังหวัดปรับตามช่วงเวลา
app.get("/api/province-index", (req, res) => {
  try {
    const db = getDb();
    const hazard = req.query.hazard_type;
    const period = req.query.period;
    let conditions = ["province IS NOT NULL"];
    let params = [];

    if (hazard && hazard !== "all") {
      conditions.push("hazard_type = ?");
      params.push(hazard);
    }
    if (period === "this_week") {
      conditions.push("post_created_at >= '2026-10-24'");
    } else if (period === "last_week") {
      conditions.push("post_created_at < '2026-10-24'");
    }

    let sql = `SELECT province, severity, COUNT(*) as cnt FROM reports WHERE ${conditions.join(" AND ")} GROUP BY province, severity`;
    const rows = db.prepare(sql).all(...params);

    const provMap = {};
    for (const r of rows) {
      if (!r.province) continue;
      if (!provMap[r.province]) {
        provMap[r.province] = { reportCount: 0, weightedScore: 0, maxSeverity: 1 };
      }
      provMap[r.province].reportCount += r.cnt;
      provMap[r.province].weightedScore += (r.severity === 3 ? 35 : (r.severity === 2 ? 15 : 5)) * r.cnt;
      if (r.severity > provMap[r.province].maxSeverity) {
        provMap[r.province].maxSeverity = r.severity;
      }
    }

    const result = {};
    for (const [pName, data] of Object.entries(provMap)) {
      const score = Math.min(100, Math.round(data.weightedScore / 2));
      result[pName] = {
        indexScore: score,
        level: data.maxSeverity,
        reportCount: data.reportCount
      };
    }
    res.json(result);
  } catch (err) {
    res.json({});
  }
});

// 3. ดึงรายงานเหตุการณ์
app.get("/api/reports", (req, res) => {
  try {
    const db = getDb();
    const hazard = req.query.hazard_type;
    const period = req.query.period;
    let conditions = [];
    let params = [];

    if (hazard && hazard !== "all") {
      conditions.push("hazard_type = ?");
      params.push(hazard);
    }
    if (period === "this_week") {
      conditions.push("post_created_at >= '2026-10-24'");
    } else if (period === "last_week") {
      conditions.push("post_created_at < '2026-10-24'");
    }

    let sql = "SELECT * FROM reports";
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY post_created_at DESC LIMIT 500";

    const rows = db.prepare(sql).all(...params).map(r => ({
      ...r,
      health_signals: JSON.parse(r.health_signals || "[]"),
      infrastructure: JSON.parse(r.infrastructure || "[]")
    }));
    res.json({ reports: rows });
  } catch (err) {
    res.json({ reports: [] });
  }
});

// 4. ถามตอบข้อมูลสถานการณ์ (Ask the Data AI)
app.post("/api/ask-water", (req, res) => {
  try {
    const db = getDb();
    const rawQ = String(req.body?.query || "").trim();
    if (!rawQ) return res.json({ answer: "กรุณาพิมพ์ชื่อจังหวัด หรืออำเภอที่ต้องการตรวจสอบครับ" });

    const knownLocs = [
      "ปราจีนบุรี", "ปราจีน", "กบินทร์บุรี", "กบินทร์", "ศรีมหาโพธิ", "ท่าตูม", "นิคม 304", "บ้านสร้าง", "นาดี", "ประจันตคาม", "ศรีมโหสถ", "เมืองปราจีน",
      "ฉะเชิงเทรา", "แปดริ้ว", "พนมสารคาม", "บางคล้า", "บางปะกง", "บ้านโพธิ์", "บางน้ำเปรี้ยว", "สนามชัยเขต", "ท่าตะเกียบ", "แปลงยาว", "ราชสาส์น", "คลองเขื่อน",
      "ระยอง", "ปลวกแดง", "นิคมพัฒนา", "บ้านค่าย", "แกลง", "เมืองระยอง", "มาบตาพุด", "บ้านฉาง", "วังจันทร์", "เขาชะเมา",
      "สระแก้ว", "กรุงเทพ", "กทม", "ชลบุรี", "เชียงใหม่", "หาดใหญ่"
    ];

    let target = null;
    for (const loc of knownLocs) {
      if (rawQ.includes(loc)) {
        target = loc;
        break;
      }
    }

    if (!target) {
      target = rawQ.replace(/มีน้ำเสียระดับไหน|น้ำเสียระดับไหน|น้ำท่วมระดับไหน|สถานการณ์|น้ำเสีย|น้ำท่วม|เป็นยังไง|ระดับไหน|ที่|จังหวัด|อำเภอ|ตำบล|ไหม|มั้ย|รึเปล่า|หรือเปล่า|ครับ|ค่ะ|ช่วย|บอก|หน่อย/g, "").trim() || rawQ;
    }

    const rows = db.prepare(`
      SELECT * FROM reports 
      WHERE province LIKE ? OR district LIKE ? OR text LIKE ?
      ORDER BY severity DESC, post_created_at DESC
    `).all(`%${target}%`, `%${target}%`, `%${target}%`);

    if (rows.length === 0) {
      return res.json({
        found: false,
        answer: `📍 พื้นที่ "${target}": ไม่พบรายงานเหตุการณ์น้ำเสียหรือน้ำท่วมในฐานข้อมูลช่วง ต.ค. 2569 (สถานะ: ปกติ / อยู่นอกพื้นที่เฝ้าระวังวิกฤตของงานวิจัย)`,
        districts: "คำแนะนำ: ลองทดสอบพื้นที่วิจัยหลัก เช่น 'ปราจีนบุรี', 'ศรีมหาโพธิ', 'บ้านสร้าง', 'บางน้ำเปรี้ยว', 'ระยอง'",
        lat: null,
        lon: null
      });
    }

    const total = rows.length;
    const wasteCnt = rows.filter(r => r.hazard_type === "contaminated_water").length;
    const floodCnt = rows.filter(r => r.hazard_type === "flood").length;
    const maxSev = Math.max(...rows.map(r => r.severity));
    const districts = [...new Set(rows.map(r => r.district).filter(Boolean))];

    const sevDesc = maxSev === 3
      ? "🔴 ระดับ 3 (วิกฤต - ตรวจพบสารเคมีอันตราย/กลิ่นฉุนรบกวนสุขภาพรุนแรง)"
      : (maxSev === 2 ? "🟠 ระดับ 2 (ปานกลาง - น้ำท่วมขัง/น้ำเน่าเสีย/กระทบสวนเกษตร)" : "🟡 ระดับ 1 (เฝ้าระวัง - น้ำรอระบาย)");

    res.json({
      found: true,
      answer: `📍 สรุปสถานการณ์ "${target}": พบรายงานทั้งหมด ${total} เคส (น้ำเสีย/สารเคมี ${wasteCnt} เคส, น้ำท่วม ${floodCnt} เคส) | ความรุนแรงสูงสุด: ${sevDesc}`,
      districts: districts.length > 0 ? `📌 อำเภอที่ตรวจพบเหตุการณ์: ${districts.join(", ")}` : "📌 รายงานภาพรวมระดับจังหวัด",
      samplePost: rows[0].text.slice(0, 150) + "...",
      lat: rows[0].lat,
      lon: rows[0].lon
    });
  } catch (err) {
    console.error("Ask AI error:", err);
    res.json({ answer: "ระบบไม่สามารถประมวลผลคำถามนี้ได้ กรุณาลองใหม่อีกครั้ง" });
  }
});

const PORT = config.port || 3000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n==============================================`);
  console.log(`🌊 Water Warning System ทำงานแล้วที่: http://localhost:${PORT}`);
  console.log(`==============================================\n`);
});