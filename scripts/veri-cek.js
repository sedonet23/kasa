// Bu script, daha önce Cloudflare Worker'larda (kasam-altin-api, kasam-piyasa) yapılan
// veri çekme işini birebir aynı mantıkla burada, GitHub Actions içinde yapar ve sonucu
// repo köküne veri.json olarak yazar. Uygulama artık canlı bir worker'a değil, bu statik
// JSON dosyasına (raw.githubusercontent.com üzerinden) bakar — Cloudflare'e hiç gitmez.

const fs = require('fs');

function sayi(str) {
    if (!str) return null;
    const n = parseFloat(String(str).replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
}

async function duzMetinAl(url, zamanAsimiMs) {
    const denetleyici = new AbortController();
    const zamanlayici = setTimeout(() => denetleyici.abort(), zamanAsimiMs || 15000);
    try {
        const r = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
            redirect: "follow",
            signal: denetleyici.signal
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
        const buf = await r.arrayBuffer();
        const html = Buffer.from(buf).toString('utf-8');
        return html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
    } finally {
        clearTimeout(zamanlayici);
    }
}

// ============================================================
// ALTIN — Elazığ Kuyumcular Odası sayfasından
// ============================================================
async function altinGetir() {
    const text = await duzMetinAl("https://fiyat.ekeo.org.tr/dashboard");

    function numbersIn(segment) {
        const matches = segment.match(/\d{1,3}(?:\.\d{3})*(?:,\d+)?/g) || [];
        return matches.map(sayi);
    }

    const anchorIdx = text.indexOf("AYAR HAS");
    if (anchorIdx === -1) {
        throw new Error("'AYAR HAS' referans noktası bulunamadı - sayfa yapısı değişmiş olabilir");
    }
    let segment = text.slice(anchorIdx);

    const labelsToStrip = [
        "24 AYAR HAS", "22 AYAR", "14 AYAR", "BEŞLİ",
        "ATA LİRA", "YARIM", "ÇEYREK", "24 AYAR 1 GRAM"
    ];
    for (const lbl of labelsToStrip) segment = segment.split(lbl).join(' ');

    const nums = numbersIn(segment);
    if (nums.length < 15) {
        throw new Error(`Beklenen sayıda fiyat bulunamadı (bulunan: ${nums.length}, beklenen: 15)`);
    }

    const gram24a = nums[0],  gram24s = nums[1];
    const gram22a = nums[2],  gram22s = nums[3];
    const ayar14s = nums[4];
    const beslia  = nums[5],  beslis  = nums[6];
    const ataa    = nums[7],  atas    = nums[8];
    const yarima  = nums[9],  yarims  = nums[10];
    const ceyreka = nums[11], ceyreks = nums[12];
    const gram24_1g_a = nums[13], gram24_1g_s = nums[14];

    if (!gram24a || !gram24s) {
        throw new Error("24 AYAR HAS fiyatı bulunamadı");
    }

    return {
        gram24a, gram24s,
        gram22a, gram22s,
        ceyreka, ceyreks,
        yarima,  yarims,
        ataa,    atas,
        beslia, beslis,
        ayar14s,
        gram24_1g_a, gram24_1g_s,
        altinKaynak: "fiyat.ekeo.org.tr"
    };
}

// ============================================================
// DÖVİZ — kur.doviz.com (serbest piyasa tablosu, ~50 kur)
// ============================================================
async function dovizGetir() {
    const text = await duzMetinAl("https://kur.doviz.com");

    const re = /\b([A-Z]{3})\b[^%\d]{0,60}?(\d+,\d+)\s+(\d+,\d+)\s+\d+,\d+\s+\d+,\d+\s+%(-?\d+,\d+)/g;
    const dovizler = [];
    const gorulen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
        const kod = m[1];
        if (kod === 'TRY' || gorulen.has(kod)) continue;
        gorulen.add(kod);
        dovizler.push({
            kod,
            alis: sayi(m[2]),
            satis: sayi(m[3]),
            degisimYuzde: sayi(m[4])
        });
    }

    if (dovizler.length === 0) {
        throw new Error("Hiç döviz satırı bulunamadı - sayfa yapısı değişmiş olabilir");
    }

    return { dovizler, dovizKaynak: "kur.doviz.com" };
}

// ============================================================
// PİYASALAR — www.doviz.com (BIST 100 / Brent Petrol / Ons Altın)
// ============================================================
async function piyasaGetir() {
    const text = await duzMetinAl("https://www.doviz.com");

    const bul = (etiket) => {
        const kacis = etiket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(kacis + '\\s+\\$?([\\d.,]+)\\s+%');
        const eslesme = text.match(re);
        return eslesme ? sayi(eslesme[1]) : null;
    };

    const bist100 = bul('BIST 100');
    const petrol  = bul('Brent Petrol');
    const ons     = bul('Altın Ons') ?? bul('Ons Altın');

    if (bist100 === null && petrol === null && ons === null) {
        throw new Error("BIST 100 / Petrol / Ons hiçbiri bulunamadı - sayfa yapısı değişmiş olabilir");
    }

    return { bist100, petrol, ons, piyasaKaynak: "www.doviz.com" };
}

async function main() {
    // Eski veri.json varsa, bir kaynak başarısız olduğunda son bilinen değerleri
    // kaybetmemek için önce onu okuyoruz.
    let eskiVeri = {};
    try {
        eskiVeri = JSON.parse(fs.readFileSync('veri.json', 'utf-8'));
    } catch (e) {
        // İlk çalıştırma ya da dosya bozuk — sorun değil, boş başlarız.
    }

    const sonuc = {};

    const [altinSonuc, dovizSonuc, piyasaSonuc] = await Promise.allSettled([
        altinGetir(), dovizGetir(), piyasaGetir()
    ]);

    if (altinSonuc.status === 'fulfilled') {
        Object.assign(sonuc, altinSonuc.value);
    } else {
        console.error("Altın hatası:", altinSonuc.reason.message);
        sonuc.altinHata = altinSonuc.reason.message;
        // Başarısızsa eski değerleri koru
        ['gram24a','gram24s','gram22a','gram22s','ceyreka','ceyreks','yarima','yarims',
         'ataa','atas','beslia','beslis','ayar14s','gram24_1g_a','gram24_1g_s','altinKaynak']
            .forEach(k => { if (eskiVeri[k] !== undefined) sonuc[k] = eskiVeri[k]; });
    }

    if (dovizSonuc.status === 'fulfilled') {
        Object.assign(sonuc, dovizSonuc.value);
    } else {
        console.error("Döviz hatası:", dovizSonuc.reason.message);
        sonuc.dovizHata = dovizSonuc.reason.message;
        if (eskiVeri.dovizler) { sonuc.dovizler = eskiVeri.dovizler; sonuc.dovizKaynak = eskiVeri.dovizKaynak; }
    }

    if (piyasaSonuc.status === 'fulfilled') {
        Object.assign(sonuc, piyasaSonuc.value);
    } else {
        console.error("Piyasa hatası:", piyasaSonuc.reason.message);
        sonuc.piyasaHata = piyasaSonuc.reason.message;
        ['bist100','petrol','ons','piyasaKaynak'].forEach(k => { if (eskiVeri[k] !== undefined) sonuc[k] = eskiVeri[k]; });
    }

    sonuc.guncellemeZamani = new Date().toISOString();

    fs.writeFileSync('veri.json', JSON.stringify(sonuc, null, 2) + '\n');
    console.log('veri.json yazıldı.');
}

main().catch(e => {
    console.error('Beklenmeyen hata:', e);
    process.exit(1);
});
