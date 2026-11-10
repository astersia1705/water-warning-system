import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertRawPost, insertProcessedReport } from '../src/db.js';
import { PROVINCE_CENTROIDS, findProvinceInText } from '../src/taxonomy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    result.push(current);
    return result;
}

// ระบบสกัดข้อมูลอัตโนมัติ (Fast Rule-based Extractor)
function smartExtract(text) {
    const isWaste = /น้ำเสีย|น้ำเน่า|น้ำดำ|สารเคมี|กากอุตสาหกรรม|ขยะพิษ|ปลาตาย|กลิ่นเหม็น|ปนเปื้อน|คราบน้ำมัน|สีรุ้ง/.test(text);
    const isFlood = /น้ำท่วม|น้ำหลาก|เอ่อล้น|จมน้ำ|ลุยน้ำ|น้ำป่า/.test(text);

    if (!isWaste && !isFlood) return null;

    const hazard_type = isWaste ? 'contaminated_water' : 'flood';

    // ประเมินระดับความรุนแรง 1-3 ตามเกณฑ์วิจัย
    let severity = 1;
    if (/วิกฤต|สารพิษ|ตายเกลื่อน|โลหะหนัก|โรงงาน|ฉุกเฉิน|เสียชีวิต|เกินมาตรฐาน/.test(text)) {
        severity = 3;
    } else if (/เน่าเหม็น|น้ำดำ|เข้าบ้าน|ท่วมขัง|ตัดทาง|ปลาตาย|ผื่นขึ้น|แน่นหน้าอก/.test(text)) {
        severity = 2;
    }

    // หาจังหวัดและอำเภอ
    let province = 'ปราจีนบุรี';
    if (text.includes('ฉะเชิงเทรา') || text.includes('แปดริ้ว') || text.includes('บางคล้า') || text.includes('บางน้ำเปรี้ยว') || text.includes('แปลงยาว')) {
        province = 'ฉะเชิงเทรา';
    } else if (text.includes('ระยอง') || text.includes('ปลวกแดง') || text.includes('บ้านค่าย') || text.includes('แกลง') || text.includes('มาบตาพุด')) {
        province = 'ระยอง';
    } else if (text.includes('ภูเก็ต')) {
        province = 'ภูเก็ต';
    } else if (text.includes('เชียงใหม่') || text.includes('เชียงราย') || text.includes('น่าน')) {
        province = text.includes('เชียงใหม่') ? 'เชียงใหม่' : (text.includes('เชียงราย') ? 'เชียงราย' : 'น่าน');
    } else {
        const detected = findProvinceInText(text);
        if (detected) province = detected.th;
    }

    // ดึงชื่ออำเภอที่พบบ่อย
    let district = null;
    const districts = ['ศรีมหาโพธิ', 'บ้านสร้าง', 'กบินทร์บุรี', 'ศรีมโหสถ', 'บางคล้า', 'บางน้ำเปรี้ยว', 'แปลงยาว', 'พนมสารคาม', 'บ้านค่าย', 'ปลวกแดง', 'แกลง', 'เมือง'];
    for (const d of districts) {
        if (text.includes(d)) {
            district = d;
            break;
        }
    }

    // สกัดอาการสุขภาพ
    const health_signals = [];
    if (text.includes('ผื่น') || text.includes('คัน')) health_signals.push('ผื่นคันตามผิวหนัง');
    if (text.includes('แสบจมูก') || text.includes('กลิ่นฉุน') || text.includes('เหม็น')) health_signals.push('แสบจมูก/กลิ่นฉุนรุนแรง');
    if (text.includes('แน่นหน้าอก') || text.includes('คลื่นไส้')) health_signals.push('แน่นหน้าอก/คลื่นไส้');
    if (text.includes('ปลาตาย')) health_signals.push('สัตว์น้ำ/ปลาตาย');

    // หาพิกัดอิงจังหวัด (สุ่ม offset เล็กน้อยเพื่อไม่ให้หมุดซ้อนทับกันที่จุดเดียว)
    const baseCoord = PROVINCE_CENTROIDS[province] || { lat: 13.7563, lng: 100.5018 };
    const jitterLat = (Math.random() - 0.5) * 0.08;
    const jitterLng = (Math.random() - 0.5) * 0.08;

    return {
        hazard_type,
        severity,
        urgency: severity === 3 ? 'critical' : (severity === 2 ? 'high' : 'medium'),
        confidence: 0.9,
        province,
        district,
        lat: baseCoord.lat + jitterLat,
        lng: baseCoord.lng + jitterLng,
        health_signals,
        summary: text.substring(0, 100) + '...'
    };
}

async function run() {
    const csvFiles = fs.readdirSync(rootDir).filter(f => f.endsWith('.csv'));
    const seenIds = new Set();
    let totalProcessed = 0;

    console.log(`เริ่มประมวลผลไฟล์ CSV ทั้งหมดเข้าสู่ Database 1 และ Database 2...`);

    for (const file of csvFiles) {
        const filePath = path.join(rootDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);

        for (let i = 1; i < lines.length; i++) {
            const row = parseCSVLine(lines[i]);
            if (row.length < 5) continue;

            let url = '';
            for (const cell of row) {
                if (cell.includes('/status/') && !cell.includes('photo') && !cell.includes('analytics')) {
                    url = cell.split('?')[0];
                    break;
                }
            }
            if (!url) continue;

            const tweetId = url.split('/status/').pop().split('/')[0];
            if (seenIds.has(tweetId)) continue;
            seenIds.add(tweetId);

            const textParts = [];
            for (const cell of row) {
                const c = cell.trim();
                if (!c || c.startsWith('http') || c.startsWith('blob:') || c.startsWith('@') || c.includes('Show more')) continue;
                textParts.push(c);
            }
            const fullText = textParts.join(' ');
            if (fullText.length < 15) continue;

            const post = {
                id: tweetId,
                source: 'x',
                author: 'twitter_user',
                created_at: '2026-10-25T12:00:00Z',
                url: url,
                text: fullText
            };

            // 1. ลง Database 1: Raw Data
            insertRawPost(post);

            // 2. สกัดข้อมูลลง Database 2: Processed Data
            const extracted = smartExtract(fullText);
            if (extracted) {
                insertProcessedReport({
                    id: 'rep_' + tweetId,
                    raw_post_id: tweetId,
                    source: 'x',
                    original_text: fullText,
                    post_created_at: post.created_at,
                    ...extracted
                });
                totalProcessed++;
            }
        }
    }

    console.log(`\nเสร็จสมบูรณ์!`);
    console.log(`- บันทึก Raw Data ลง data/raw_data.sqlite เรียบร้อย`);
    console.log(`- สกัดข้อมูลรายงานภัยพิบัติลง data/processed_data.sqlite จำนวน ${totalProcessed} รายงาน พร้อมแสดงผลบนแผนที่ทันที!`);
}

run();