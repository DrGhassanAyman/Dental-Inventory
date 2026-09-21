# نظام جرد عيادة الأسنان - النسخة المتكاملة مع واتساب API

## المميزات
- مخزن مطابق 100% للصورة الأصلية (10 جرارات + 2 خزانة)
- صور حقيقية للجرارات والخزائن عند الفتح
- إضافة صور للمواد وتعديل حجمها ومكانها بالسحب
- حد تنبيه لكل مادة مع تنبيهات بصرية
- إدارة موردين مع أرقام هواتف وواتساب
- ربط واتساب وضعان:
  1. الوضع العادي wa.me - يفتح واتساب برسالة جاهزة (مجاني)
  2. وضع Cloud API التلقائي - إرسال تلقائي 100% عبر WhatsApp Business API

## طريقة التشغيل
1. افتح index.html في المتصفح (Chrome يفضل)
2. لا يحتاج خادم - يعمل مباشرة
3. أو شغل خادم محلي: python -m http.server 8000
4. أو: npm start (يشغل server.js بدون أي مكتبات خارجية)

## النشر على Render
المشروع موقع ثابت (Static Site) — لا يحتاج أي خطوة بناء (build). لديك طريقتان:

### الطريقة 1: كموقع ثابت (الموصى بها - مجانية)
- عبر Blueprint: New → Blueprint واختر المستودع، وسيتعرف Render على render.yaml تلقائياً
- أو يدوياً: New → Static Site ثم:
  - Build Command: اتركه **فارغاً** (أو `npm run build` — يعمل أيضاً ولا يفعل شيئاً)
  - Publish Directory: `./`

### الطريقة 2: كخادم Node.js (إذا أردت خادم واتساب الوسيط أيضاً)
- New → Web Service ثم:
  - Build Command: `npm install && npm run build`
  - Start Command: `npm start`
- server.js يخدم الملفات الثابتة ويوفر نقطة نهاية اختيارية `/api/send-whatsapp` لتجاوز CORS

## ربط واتساب Business API (للإرسال التلقائي الكامل)
1. اذهب لـ https://developers.facebook.com
2. إنشاء تطبيق -> نوع Business -> إضافة منتج WhatsApp
3. من WhatsApp -> API Setup -> انسخ:
   - Phone Number ID
   - Access Token (مؤقت 24 ساعة أو دائم)
4. في البرنامج: 📱 ربط واتساب -> اختر "API تلقائي كامل" -> الصق البيانات -> حفظ
5. اختبر بـ "اختبار API"

ملاحظة: إرسال Cloud API من المتصفح قد يواجه CORS. للإنتاج، يفضل استخدام خادم وسيط بسيط (Node.js/Express) يرسل الطلبات لـ graph.facebook.com

مثال خادم Node.js موجود في ملف server-example.js

## الملفات
- index.html: البرنامج الرئيسي
- images/full.jpg: صورة المخزن الحقيقي
- images/drawer.jpg: جرار فارغ حقيقي
- images/cabinet.jpg: خزانة فارغة حقيقية
- dental-data.json: مثال بيانات (إن وجد)

## البيانات
جميع البيانات محفوظة في localStorage تحت مفتاح dental_inventory_v5
يمكنك تصديرها واستيرادها من الأزرار العلوية.

تم التطوير لعيادة أسنان في الأردن - عمان
