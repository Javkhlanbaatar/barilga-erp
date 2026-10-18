'use client';

import { useEffect, useRef, useState } from 'react';
import { Barcode } from '@/components/barcode';
import { Shell } from '@/components/shell';
import { apiOrigin } from '@/lib/api';

type Check = { ok: boolean | null; text: string };

/**
 * Төхөөрөмж шалгах. A browser cannot list the printers or USB devices attached to the computer, so each
 * device is checked by using it: scan into the box, print a test page on each printer. The card terminal is
 * the bank's own machine and is not connected to the ERP.
 */
export default function DevicesPage() {
  const [server, setServer] = useState<Check>({ ok: null, text: 'Шалгаж байна…' });
  const [online, setOnline] = useState(true);
  const [scan, setScan] = useState<Check>({ ok: null, text: 'Доорх нүдэнд дарж аль нэг барааг сканнердана уу.' });
  const [code, setCode] = useState('');
  const times = useRef<number[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const started = Date.now();
    fetch(`${apiOrigin()}/api/health`)
      .then((r) => setServer({ ok: r.ok, text: r.ok ? `Сервер ажиллаж байна (${Date.now() - started} мс)` : `Сервер алдаа өгч байна (${r.status})` }))
      .catch(() => setServer({ ok: false, text: 'Сервертэй холбогдож чадсангүй. Компьютер дээр «npm run dev:all» ажиллаж байгаа эсэхийг шалгана уу.' }));
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  /** A scanner types the whole code in well under 50 ms per key and ends with Enter; a person types slower. */
  function onScanKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const t = times.current;
      const gaps = t.slice(1).map((x, i) => x - t[i]);
      const avg = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : Infinity;
      const value = code.trim();
      if (!value) return;
      if (avg < 50) setScan({ ok: true, text: `Баркод уншигч ажиллаж байна ✓ — уншсан код: ${value}` });
      else setScan({ ok: false, text: `«${value}» гараар бичигдсэн бололтой. Уншигчийн USB-г шалгаад дахин сканнердана уу (уншигч Enter дардаг байх ёстой).` });
      times.current = [];
      setCode('');
      return;
    }
    if (e.key.length === 1) times.current.push(performance.now());
  }

  return (
    <Shell>
      <div className="mb-4">
        <h2 className="text-xl font-bold">Төхөөрөмж шалгах</h2>
        <p className="mt-1 text-sm text-slate-400">
          Вэб программ компьютерт залгасан принтер, USB төхөөрөмжийн жагсаалтыг харж чаддаггүй. Тиймээс төхөөрөмж бүрийг ашиглаж шалгана.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Сервер ба интернэт">
          <Status check={server} />
          <Status check={{ ok: online, text: online ? 'Сүлжээнд холбогдсон' : 'Сүлжээ тасарсан байна' }} />
        </Card>

        <Card title="Баркод уншигч">
          <Status check={scan} />
          <input
            ref={input}
            className="w-full font-mono"
            placeholder="Энд дараад сканнердана уу"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={onScanKey}
          />
          <p className="text-xs text-slate-500">
            Уншигч ажиллахгүй бол: USB-г дахин залгах, уншигчийг «USB keyboard (HID)» горимд тохируулах, кирилл гар идэвхтэй бол латин руу шилжүүлэх. Шалгах код:
          </p>
          <div className="w-fit rounded bg-white p-2">
            <Barcode value="2000000000015" height={36} />
          </div>
        </Card>

        <Card title="Баримтын принтер (58/80 мм)">
          <p className="text-sm text-slate-300">Туршилтын баримт хэвлэж, өргөн, үсгийн тод байдлыг шалгана.</p>
          <TestPrint kind="receipt" label="80 мм туршилтын баримт хэвлэх" />
          <p className="text-xs text-slate-500">Хэвлэх цонхонд баримтын принтерээ сонгож, «Margins: None» болгоно. Захиалга бүрийн баримтыг захиалгын хуудаснаас хэвлэнэ.</p>
        </Card>

        <Card title="A4 / А5 принтер ба 3 давхар (матрицан) принтер">
          <p className="text-sm text-slate-300">
            Нэхэмжлэх, зарлагын баримтыг A4 эсвэл A5-аар хэвлэнэ. Матрицан (3 давхар цаастай) принтерийг Windows-д ердийн принтер шиг суулгаад энд сонгоно.
          </p>
          <div className="flex flex-wrap gap-2">
            <TestPrint kind="a4" label="A4 туршилт" />
            <TestPrint kind="a5" label="A5 хэвтээ туршилт (3 давхар)" />
          </div>
          <p className="text-xs text-slate-500">Цаасны хэмжээ, чиглэлийг «Компанийн мэдээлэл → Хэвлэх тохиргоо» хэсэгт баримт тус бүрээр тохируулна.</p>
        </Card>

        <Card title="Баркод шошгоны принтер">
          <p className="text-sm text-slate-300">58×40, 40×30 мм наалт хэвлэгч эсвэл A4 наалттай хуудас.</p>
          <a className="btn-ghost w-fit text-sm" href="/print/labels" target="_blank" rel="noreferrer">
            Шошго хэвлэх хуудас нээх
          </a>
        </Card>

        <Card title="Картын терминал (банкны POS)">
          <p className="text-sm text-slate-300">
            Банкны картын терминал ERP-тэй холбогддоггүй, тусдаа ажиллана. Терминал дээр гүйлгээ амжилттай болсны дараа ПОС дээр «Карт» төлбөрөөр
            бүртгэнэ. Өдрийн эцэст терминалын тайлан болон «Касс» тайлангийн картын дүнг тулгана.
          </p>
          <p className="text-xs text-slate-500">Банктай шууд холбох (интеграц) нь тухайн банкны гэрээ, API түлхүүр шаардана.</p>
        </Card>
      </div>
    </Shell>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Status({ check }: { check: Check }) {
  const color = check.ok === null ? 'bg-slate-500' : check.ok ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <p className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
      {check.text}
    </p>
  );
}

/** Opens a small test page in a new window and prints it. */
function TestPrint({ kind, label }: { kind: 'receipt' | 'a4' | 'a5'; label: string }) {
  function go() {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const page = kind === 'receipt' ? '80mm auto' : kind === 'a4' ? 'A4 portrait' : 'A5 landscape';
    const width = kind === 'receipt' ? '72mm' : '100%';
    const now = new Date().toLocaleString('mn-MN');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Туршилт</title><style>
      @page { size: ${page}; margin: ${kind === 'receipt' ? '2mm' : '12mm'}; }
      body { font-family: monospace; width: ${width}; margin: 0 auto; }
      .row { display: flex; justify-content: space-between; } h1 { font-size: 16px; text-align: center; }
      .ruler { border-top: 1px dashed #000; margin: 6px 0; }
    </style></head><body>
      <h1>ТУРШИЛТЫН ХЭВЛЭЛТ</h1>
      <p>${now}</p><div class="ruler"></div>
      <div class="row"><span>Цемент M400 × 2</span><span>37,000₮</span></div>
      <div class="row"><span>Арматур Ø12 × 10</span><span>320,000₮</span></div>
      <div class="ruler"></div>
      <div class="row"><b>НИЙТ</b><b>357,000₮</b></div>
      <p>АБВГДЕЁЖЗИЙКЛМНОӨПРСТУҮФХЦЧШЩЪЫЬЭЮЯ<br>abcdefghijklmnopqrstuvwxyz 0123456789</p>
      <p>Энэ мөр бүтэн харагдаж байвал өргөн зөв.</p>
      <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
    </body></html>`);
    w.document.close();
  }
  return (
    <button type="button" className="btn-ghost w-fit text-sm" onClick={go}>
      {label}
    </button>
  );
}
