'use client';

import JsBarcode from 'jsbarcode';
import { useEffect, useRef } from 'react';
import { barcodeFormat } from './barcode-format';

export { barcodeFormat };

/** Barcode drawn as SVG (sharp on any printer). */
export function Barcode({ value, height = 40, width = 1.6, fontSize = 12 }: { value: string; height?: number; width?: number; fontSize?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, { format: barcodeFormat(value), height, width, fontSize, margin: 0, background: '#ffffff', lineColor: '#000000' });
    } catch {
      ref.current.innerHTML = '';
    }
  }, [value, height, width, fontSize]);
  return <svg ref={ref} className="max-w-full" />;
}
