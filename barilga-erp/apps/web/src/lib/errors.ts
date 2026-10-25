/**
 * Turns what the API says into a sentence a shop worker understands. Messages the server already writes in
 * Mongolian ("Монгол / English") keep their Mongolian part; known English ones are translated; anything else
 * falls back to a plain sentence for its HTTP status, with the original kept in brackets for support.
 */

const CYRILLIC = /[А-Яа-яӨөҮүЁё]/;

const NOUNS: Record<string, string> = {
  Order: 'Захиалга',
  'Order item': 'Захиалгын мөр',
  Product: 'Бараа',
  Customer: 'Харилцагч',
  Invoice: 'Нэхэмжлэх',
  Payment: 'Төлбөр',
  Warehouse: 'Дэлгүүр/агуулах',
  Transfer: 'Шилжүүлэг',
  Receipt: 'Орлогын баримт',
  'Receipt line': 'Орлогын мөр',
  'Price list': 'Үнийн жагсаалт',
  User: 'Хэрэглэгч',
  'Staff member': 'Ажилтан',
  'Attendance record': 'Ирцийн бүртгэл',
  Request: 'Хүсэлт',
  'Day status': 'Өдрийн төлөв',
  'Payroll row': 'Цалингийн мөр',
  Adjustment: 'Нэмэгдэл/суутгал',
  Entry: 'Бичилт',
  'Supplier partner': 'Нийлүүлэгч',
  Return: 'Буцаалт',
};

/** Exact (or prefix) English messages → Mongolian. */
const EXACT: Array<[RegExp, string]> = [
  [/^Invalid credentials/, 'Нэвтрэх нэр эсвэл нууц үг буруу байна.'],
  [/^Unauthorized$/, 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.'],
  [/^Username or email already in use/, 'Энэ нэвтрэх нэр эсвэл и-мэйл бүртгэлтэй байна.'],
  [/^SKU .* already exists/, 'Ийм кодтой бараа бүртгэлтэй байна.'],
  [/^Warehouse code .* already exists/, 'Ийм кодтой дэлгүүр/агуулах бүртгэлтэй байна.'],
  [/^A price list with this name already exists/, 'Ийм нэртэй үнийн жагсаалт бүртгэлтэй байна.'],
  [/^Cannot deactivate or demote the last active admin/, 'Сүүлийн идэвхтэй админыг хасах боломжгүй.'],
  [/^You cannot deactivate your own account/, 'Өөрийгөө идэвхгүй болгох боломжгүй.'],
  [/^Customer is deactivated/, 'Энэ харилцагч идэвхгүй болсон байна.'],
  [/^One or more products are invalid or inactive/, 'Зарим бараа идэвхгүй эсвэл устсан байна. Сагсаа шалгана уу.'],
  [/^Order is cancelled/, 'Захиалга цуцлагдсан байна.'],
  [/^Invoice was cancelled/, 'Нэхэмжлэх цуцлагдсан байна.'],
  [/^customerId is required/, 'Харилцагч сонгоно уу.'],
  [/^days must be/, 'Хоногийн тоо 1–90 байх ёстой.'],
  [/^Amount is too large/, 'Дүн хэт их байна.'],
  [/^reason is required/, 'Шалтгаанаа бичнэ үү.'],
  [/^baseSalaryMnt is required/, 'Цалингийн дүнг оруулна уу (хоосон бол «цалингүй»).'],
  [/^Only admin can change the working day/, 'Ажлын цагийг зөвхөн админ тохируулна.'],
  [/^Order is no longer awaiting payment/, 'Захиалга төлбөр хүлээхээ больсон байна (төлөгдсөн эсвэл цуцлагдсан).'],
  [/^Only orders awaiting payment can be cancelled/, 'Зөвхөн төлбөр хүлээж буй захиалгыг цуцална.'],
  [/^Returns are only allowed after the order is paid/, 'Төлөгдсөн захиалгад л буцаалт хийнэ.'],
  [/^Return quantity must be positive|^Refund amount must be greater than 0/, 'Буцаах тоо, дүн 0-ээс их байх ёстой.'],
  [/^Each .* may appear only once/, 'Нэг бараа нэг л удаа орно.'],
  [/^Every quantity must be greater than zero|^Quantity cannot be negative/, 'Тоо ширхэг 0-ээс их байх ёстой.'],
  [/^Amount must be|^An adjustment cannot be 0|^At least one payment split/, 'Дүн 0-ээс их байх ёстой.'],
  [/^Nothing is owed on this order/, 'Энэ захиалгад өр алга.'],
  [/^Only one on-account \(CREDIT\) part per order/, 'Нэг захиалгад зээлээр нэг л хэсэг олгоно.'],
  [/^Source and destination must be different/, 'Илгээх, хүлээн авах газар өөр байх ёстой.'],
  [/^Both warehouses must be active|^Warehouse is not active|^Warehouse not found or (inactive|not active)/, 'Дэлгүүр/агуулах идэвхгүй байна.'],
  [/^This transfer is no longer in transit|^Only a transfer that is still in transit/, 'Шилжүүлэг замд байхаа больсон (хүлээн авсан эсвэл цуцлагдсан).'],
  [/^Product is not on this transfer/, 'Энэ бараа шилжүүлэгт байхгүй.'],
  [/^This warehouse still holds stock/, 'Энэ дэлгүүр/агуулахад үлдэгдэл байна. Эхлээд шилжүүлэх эсвэл 0 болгоно уу.'],
  [/^Active users are still assigned to this warehouse/, 'Энэ дэлгүүр/агуулахад ажилтан томилогдсон байна. Эхлээд өөр газар шилжүүлнэ үү.'],
  [/^Transfers into or out of this warehouse are still in transit/, 'Энэ дэлгүүр/агуулахын замд яваа шилжүүлэг байна. Эхлээд хүлээн авах эсвэл цуцлана уу.'],
  [/^The default warehouse cannot be deactivated|^Choose another warehouse as the default/, 'Үндсэн дэлгүүрийг идэвхгүй болгохгүй. Эхлээд өөр дэлгүүрийг үндсэн болгоно уу.'],
  [/^An inactive warehouse cannot be the default/, 'Идэвхгүй дэлгүүрийг үндсэн болгохгүй.'],
  [/^No default warehouse is configured/, 'Үндсэн дэлгүүр тохируулаагүй байна (Админ → Дэлгүүр/агуулах).'],
  [/^A reason is required/, 'Шалтгаанаа бичнэ үү.'],
  [/^The adjustment does not change the quantity|^The price is unchanged|^Fees are unchanged/, 'Өөрчлөлт алга.'],
  [/already checked in/, 'Аль хэдийн ирц бүртгүүлсэн байна.'],
  [/^No open check-in to close/, 'Ирц бүртгүүлээгүй тул явсныг бүртгэх боломжгүй.'],
  [/^Fees can(not)? (only )?be/, 'Төлбөр орсны дараа хураамж өөрчлөхгүй.'],
  [/^Cannot confirm payment status with the provider|^QPay .* failed|^QPay invoice response/, 'QPay-тэй холбогдож чадсангүй. Түр хүлээгээд дахин оролдоно уу.'],
  [/^A payment was (just )?confirmed/, 'Энэ захиалгад төлбөр дөнгөж орсон тул цуцлахгүй.'],
  [/^Offsets are made with the offset action/, 'Хасалтыг «Хасалт» үйлдлээр хийнэ.'],
  [/^This line comes from another document/, 'Энэ мөр өөр баримтаас үүссэн. Тэр баримтыг засна уу.'],
  [/^Image file is required|^Logo file is required/, 'Зураг сонгоно уу.'],
  [/^Only JPEG, PNG, WebP/, 'Зөвхөн JPEG, PNG, WebP зураг.'],
  [/^Dates must be YYYY-MM-DD|^Invalid date|^periodMonth must be YYYY-MM/, 'Огноо буруу байна.'],
  [/^endDate must be on or after startDate/, 'Дуусах огноо эхлэх огнооноос өмнө байна.'],
  [/^Module .* is switched off/, 'Энэ модуль унтраалттай байна (Админ → Модулиуд).'],
  [/^Module .* is not used/, 'Энэ модуль одоогоор ашиглагдахгүй.'],
  [/^Payment simulation is disabled/, 'Туршилтын төлбөр зөвхөн хөгжүүлэлтийн орчинд ажиллана.'],
  [/^Order value is too large/, 'Захиалгын дүн хэт их байна.'],
  [/^supplierName is required/, 'Нийлүүлэгчийн нэрийг бичнэ үү.'],
];

/** Families of messages that mean the same thing to the user. */
const FAMILIES: Array<[RegExp, string]> = [
  [/another warehouse|your own warehouse|Only staff of that warehouse|Only the two warehouses/, 'Энэ нь өөр дэлгүүр/агуулахынх тул танд хандах эрх алга.'],
  [/You must be assigned to a warehouse/, 'Таныг дэлгүүр/агуулахад томилоогүй байна. Админд хандана уу.'],
  [/just changed|changed while|reload and try again|was just paid|payable_shrank|Could not allocate/, 'Өөр хүн дөнгөж өөрчилсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу.'],
  [/^Only |is not allowed to|^Role |can only view|cannot be switched|^Warehouse staff/, 'Энэ үйлдлийг хийх эрх танд алга.'],
];

const BY_STATUS: Record<number, string> = {
  400: 'Мэдээлэл буруу эсвэл дутуу байна.',
  401: 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.',
  403: 'Энэ үйлдлийг хийх эрх танд алга.',
  404: 'Хайсан зүйл олдсонгүй.',
  409: 'Өөр хүн дөнгөж өөрчилсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу.',
  413: 'Файл хэт том байна.',
  429: 'Хэт олон оролдлого хийлээ. Түр хүлээгээд дахин оролдоно уу.',
  500: 'Системд алдаа гарлаа. Дахин оролдоод болохгүй бол админд хандана уу.',
  502: 'Сервер түр ажиллахгүй байна. Түр хүлээгээд дахин оролдоно уу.',
  503: 'Сервер түр ажиллахгүй байна. Түр хүлээгээд дахин оролдоно уу.',
};

/** class-validator: "quantity must be a number …", "name should not be empty". */
function validation(msg: string): string | null {
  const m = /^(?:[\w.]+\.)?(\w+) (must|should|has to)\b/.exec(msg);
  if (!m) return null;
  return `«${m[1]}» талбар буруу эсвэл хоосон байна.`;
}

function one(msg: string, status: number): string {
  const text = msg.trim();
  if (!text) return BY_STATUS[status] ?? 'Алдаа гарлаа.';
  if (CYRILLIC.test(text)) {
    // "Монгол / English": keep the Mongolian half.
    const [mn] = text.split(' / ');
    return CYRILLIC.test(mn) ? mn.trim() : text;
  }
  for (const [re, mn] of EXACT) if (re.test(text)) return mn;
  const nf = /^(.+?) not found/.exec(text);
  if (nf && NOUNS[nf[1]]) return `${NOUNS[nf[1]]} олдсонгүй.`;
  for (const [re, mn] of FAMILIES) if (re.test(text)) return mn;
  const v = validation(text);
  if (v) return v;
  const fallback = BY_STATUS[status] ?? (status >= 500 ? BY_STATUS[500] : 'Алдаа гарлаа.');
  return `${fallback} (${text})`;
}

/** The message to show for a failed API call. */
export function errorMessage(status: number, message: unknown): string {
  const list = Array.isArray(message) ? message.map(String) : message ? [String(message)] : [];
  if (!list.length) return BY_STATUS[status] ?? (status >= 500 ? BY_STATUS[500] : 'Алдаа гарлаа.');
  return [...new Set(list.map((m) => one(m, status)))].join(' ');
}
