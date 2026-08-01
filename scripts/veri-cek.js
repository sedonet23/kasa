// Kasam — statik yedek veri üretici
// Cloudflare Worker'larla (kasam-altin-api, kasam-piyasa) TAMAMEN AYNI mantıkla
// altın + döviz + piyasa verisini çeker, veri/kasam-veri.json dosyasına yazar.
// Bu dosya GitHub Actions tarafından periyodik çalıştırılır; uygulama, worker'lara
// hiç ulaşamadığında bu dosyayı (raw.githubusercontent.com üzerinden) yedek olarak okur.

const fs = require('fs');
const path = require('path');

const sayi = (str) => {
    if (!str) return null;
    const n = parseFloat(String(str).replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
};

async function duzMetinAl(url, zamanAsimiMs, maxUzunluk) {
    const denetleyici = new AbortController();
    const zamanlayici = setTimeout(() => denetleyici.abort(), zamanAsimiMs || 15000);
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
            redirect: 'follow',
            signal: denetleyici.signal
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
        const buf = await r.arrayBuffer();
        const html = Buffer.from(buf).toString('utf-8');
        let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
        if (maxUzunluk && text.length > maxUzunluk) text = text.slice(0, maxUzunluk);
        return text;
    } finally {
        clearTimeout(zamanlayici);
    }
}

// ============================================================
// ALTIN — Elazığ Kuyumcular Odası sayfasından
// ============================================================
async function altinWorkerdanGetir() {
    const denetleyici = new AbortController();
    const zamanlayici = setTimeout(() => denetleyici.abort(), 15000);
    try {
        const r = await fetch('https://kasam-altin-api.sedonet23.workers.dev/', { signal: denetleyici.signal });
        if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);
        const data = await r.json();
        if (data.hata) throw new Error(`Worker hata döndürdü: ${data.hata}`);
        if (!(sayi(data.gram24s) > 0)) throw new Error('Worker geçersiz veri döndürdü');
        return {
            gram24a: sayi(data.gram24a), gram24s: sayi(data.gram24s),
            gram22a: sayi(data.gram22a), gram22s: sayi(data.gram22s),
            ceyreka: sayi(data.ceyreka), ceyreks: sayi(data.ceyreks),
            yarima: sayi(data.yarima),   yarims: sayi(data.yarims),
            ataa: sayi(data.ataa),        atas: sayi(data.atas),
            beslia: sayi(data.beslia),   beslis: sayi(data.beslis),
            ayar14s: sayi(data.ayar14s),
            gram24_1g_a: sayi(data.gram24_1g_a), gram24_1g_s: sayi(data.gram24_1g_s),
            altinKaynak: 'fiyat.ekeo.org.tr (kasam-altin-api worker üzerinden)'
        };
    } finally {
        clearTimeout(zamanlayici);
    }
}

async function altinDogrudanEkeodanGetir() {
    const text = await duzMetinAl('https://fiyat.ekeo.org.tr/dashboard', 15000);

    function numbersIn(segment) {
        const matches = segment.match(/\d{1,3}(?:\.\d{3})*(?:,\d+)?/g) || [];
        return matches.map(sayi);
    }

    const anchorIdx = text.indexOf('AYAR HAS');
    if (anchorIdx === -1) {
        throw new Error("'AYAR HAS' referans noktası bulunamadı - sayfa yapısı değişmiş olabilir");
    }
    let segment = text.slice(anchorIdx);

    const labelsToStrip = [
        '24 AYAR HAS', '22 AYAR', '14 AYAR', 'BEŞLİ',
        'ATA LİRA', 'YARIM', 'ÇEYREK', '24 AYAR 1 GRAM'
    ];
    for (const lbl of labelsToStrip) segment = segment.split(lbl).join(' ');

    const nums = numbersIn(segment);
    if (nums.length < 15) {
        throw new Error(`Beklenen sayıda fiyat bulunamadı (bulunan: ${nums.length}, beklenen: 15)`);
    }

    const gram24a = nums[0], gram24s = nums[1];
    const gram22a = nums[2], gram22s = nums[3];
    const ayar14s = nums[4];
    const beslia = nums[5], beslis = nums[6];
    const ataa = nums[7], atas = nums[8];
    const yarima = nums[9], yarims = nums[10];
    const ceyreka = nums[11], ceyreks = nums[12];
    const gram24_1g_a = nums[13], gram24_1g_s = nums[14];

    if (!gram24a || !gram24s) {
        throw new Error('24 AYAR HAS fiyatı bulunamadı');
    }

    return {
        gram24a, gram24s,
        gram22a, gram22s,
        ceyreka, ceyreks,
        yarima, yarims,
        ataa, atas,
        beslia, beslis,
        ayar14s,
        gram24_1g_a, gram24_1g_s,

        altinKaynak: 'fiyat.ekeo.org.tr'
    };
}

async function altinGetir() {
    try {
        return await altinWorkerdanGetir();
    } catch (workerHata) {
        console.warn('Altın worker üzerinden alınamadı, doğrudan ekeo deneniyor:', workerHata.message);
        return await altinDogrudanEkeodanGetir();
    }
}

// ============================================================
// DÖVİZ — kur.doviz.com (serbest piyasa tablosu, ~50 kur)
// ============================================================
async function dovizGetir() {
    const text = await duzMetinAl('https://kur.doviz.com', 15000, 350000);

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
        throw new Error('Hiç döviz satırı bulunamadı - sayfa yapısı değişmiş olabilir');
    }

    return { dovizler, dovizKaynak: 'kur.doviz.com' };
}

// ============================================================
// PİYASALAR — www.doviz.com (BIST 100 / Brent Petrol / Ons Altın)
// ============================================================
async function piyasaGetir() {
    const text = await duzMetinAl('https://www.doviz.com', 15000, 300000);

    const bul = (etiket) => {
        const kacis = etiket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(kacis + '\\s+\\$?([\\d.,]+)\\s+%');
        const eslesme = text.match(re);
        return eslesme ? sayi(eslesme[1]) : null;
    };

    const bist100 = bul('BIST 100');
    const petrol = bul('Brent Petrol');
    const ons = bul('Altın Ons') ?? bul('Ons Altın');

    if (bist100 === null && petrol === null && ons === null) {
        throw new Error('BIST 100 / Petrol / Ons hiçbiri bulunamadı - sayfa yapısı değişmiş olabilir');
    }

    return { bist100, petrol, ons, piyasaKaynak: 'www.doviz.com' };
}

async function calistir() {
    const sonuc = {};

    const [altinSonuc, dovizSonuc, piyasaSonuc] = await Promise.allSettled([
        altinGetir(), dovizGetir(), piyasaGetir()
    ]);

    if (altinSonuc.status === 'fulfilled') {
        Object.assign(sonuc, altinSonuc.value);
    } else {
        console.error('Altın hatası:', altinSonuc.reason.message);
        sonuc.altinHata = altinSonuc.reason.message;
    }

    if (dovizSonuc.status === 'fulfilled') {
        Object.assign(sonuc, dovizSonuc.value);
    } else {
        console.error('Döviz hatası:', dovizSonuc.reason.message);
        sonuc.dovizHata = dovizSonuc.reason.message;
    }

    if (piyasaSonuc.status === 'fulfilled') {
        Object.assign(sonuc, piyasaSonuc.value);
    } else {
        console.error('Piyasa hatası:', piyasaSonuc.reason.message);
        sonuc.piyasaHata = piyasaSonuc.reason.message;
    }

    sonuc.guncellemeZamani = new Date().toISOString();

    const cikisDizini = path.join(__dirname, '..', 'veri');
    fs.mkdirSync(cikisDizini, { recursive: true });
    fs.writeFileSync(path.join(cikisDizini, 'kasam-veri.json'), JSON.stringify(sonuc, null, 2));

    console.log('Yazıldı: veri/kasam-veri.json');
    console.log(JSON.stringify(sonuc, null, 2));

    // En az altın VEYA döviz başarılıysa iş başarılı sayılsın (ikisi birden
    // düşerse workflow'u "başarısız" işaretleyip fark edilmesini sağla).
    if (altinSonuc.status === 'rejected' && dovizSonuc.status === 'rejected') {
        process.exit(1);
    }
}

calistir().catch(e => {
    console.error('Beklenmeyen hata:', e);
    process.exit(1);
});
