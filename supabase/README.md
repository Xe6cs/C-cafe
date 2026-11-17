# قاعدة البيانات (Supabase / PostgreSQL)

هذا المجلد يصف مخطط قاعدة البيانات وصلاحياتها واختباراتها. المخطط والصلاحيات طُبِّقا فعليًا على مشروع Supabase السحابي **C-cafe** (`mzbhncsdpdbxsdswzruc`، منطقة `us-east-2`، PostgreSQL 17.11). دوال Netlify ولوحة `/admin/` على المعاينة تقرأ وتكتب عبر RPCs محمية، بينما `server.js` المحلي ما زال لا يقرأ قاعدة البيانات. المشروع السابق خارج النطاق ولم يُلمس.

## حالة المشروع السحابي

| البند | القيمة |
|---|---|
| المشروع | `C-cafe` — `mzbhncsdpdbxsdswzruc` |
| المنطقة | `us-east-2` |
| إصدار PostgreSQL | 17.11 |
| سجل الترحيلات | `20261106120000,20261106121000,20261108020000,20261109090000,20261110090000` (محلي وبعيد متطابقان) |
| المحتوى المنشور | مطابق لـ `data/content.json` |
| تسجيل المستخدمين | مغلق (`disable_signup=true`) وعبر GoTrue أيضًا |
| تسجيل الدخول بالبريد | مفعّل |
| مستخدمو auth | 0 |
| صفوف `admin_users` | 0 |
| مسودات / عمليات | 0 / 0 |
| فحوصات الظهور | 3 (سجل تدقيق لاختبارات النسختين 246 و248) |
| سجل المحتوى | 6 إصدارات (243–248) |
| العرض العام `published_content` | صف واحد فقط |
| إصدار المحتوى الحالي | `248` (المحتوى الأصلي) |

> ملاحظة: `site_content.version` قيمة تشغيلية عالية بعد الاختبارات، وليست `1`. أُعيد المحتوى الأصلي كإصدار **جديد** (248) ولم تُعد أرقام الإصدارات إلى الوراء، لأن إعادة التدوير كانت ستُخفي تاريخًا حقيقيًا. الإصدارات 244–248 تجريبية وموسومة بملاحظات `phase5:` في السجل.
>
> ملاحظة migrations: سُجّل `20261108020000_conflict_sqlstate.sql` (PT409) رسميًا بعد التحقق من تطابق تعريفات الدوال السبع الحية مع الملف حرفيًا (بما فيها `SECURITY DEFINER` و`search_path=''` والتوقيعات). وسُجّل `20261109090000_media_library.sql` بعد تطبيقه والتحقق من الجداول والسياسات وRPCs. وسُجّل `20261110090000_media_finalize_claim.sql` بعد تطبيقه والتحقق من عمود الاستحواذ والسياسات والدوال. صار سجل `supabase_migrations.schema_migrations` مطابقًا للملفات المحلية: `20261106120000`, `20261106121000`, `20261108020000`, `20261109090000`, `20261110090000`، بلا ترحيلات مفقودة وبلا حاجة لترحيل تصحيحي.

## الملفات

| المسار | المحتوى |
|---|---|
| `supabase/migrations/20261106120000_content_core.sql` | الجداول، القيود، دوال التحقق داخل قاعدة البيانات، وتعليقات الحالة |
| `supabase/migrations/20261106121000_content_api.sql` | دوال RPC، RLS، العرض العام، ومنع الكتابة المباشرة |
| `supabase/migrations/20261108020000_conflict_sqlstate.sql` | استبدال `RAISE SQLSTATE '40001'` القابل لإعادة المحاولة بـ`PT409` فورًا، حتى لا يعيد PostgREST المحاولة حتى انتهاء المهلة |
| `supabase/migrations/20261109090000_media_library.sql` | `media_assets` و`media_secrets` وbucket خاص `ccafe-media` وسياسات Storage وRPCs الوسائط، ورفض نشر أي مرجع `media/` بـ`CC001` |
| `supabase/migrations/20261110090000_media_finalize_claim.sql` | إغلاق نافذة TOCTOU: عمود `verification_started_at`، RPC `admin_media_begin_finalize`، تجميد Storage ضد الحذف/إعادة الرفع أثناء التحقق، وإلزام الاستحواذ في `admin_media_finalize` |
| `supabase/migrations/20261114090000_analytics.sql` | `analytics_events` و`analytics_rate_limits` و`analytics_secrets`: إدخال محمي ببصمة سر خادمي، حدود مشتركة، لقطة إحصاءات للمدير، مسح بيئة واحدة، وتنظيف 90 يومًا مجدول عبر `pg_cron` |
| `supabase/migrations/20261115090000_analytics_digest_guard.sql` | بصمة إدخال من طبقتين: تُخزَّن `D2 = SHA-256("ingest|" + D1)` وتُجزَّأ القيمة الواردة مرة أخرى قبل المقارنة، فلا تصلح البصمة المخزنة كاعتماد مباشر |
| `supabase/migrations/20261116090000_analytics_day_cap.sql` | خفض سقف الإساءة اليومي من 200000 إلى 5000 بعد قياس حجم الصف والفهارس، ليبقى أسوأ حالة 90 يومًا داخل ميزانية الخطة المجانية؛ لا تغيير في التحقق أو البصمة أو الصلاحيات |
| `supabase/seed.sql` | بذرة محلية من `data/content.json` (نسخة منشورة واحدة + سجل واحد) |
| `supabase/tests/db-check.mjs` | اختبارات سريعة عبر PGlite (جلسة واحدة) |
| `supabase/tests/pg-real-check.mjs` | اختبارات PostgreSQL محلي حقيقي باتصالين مستقلين |
| `supabase/tests/http-cloud-check.mjs` | اختبارات HTTP على السحابة: Auth وPostgREST بـ JWT حقيقي |
| `supabase/tests/pg-cloud-check.mjs` | اختبارات التزامن على PostgreSQL 17.11 السحابي باتصالين |
| `supabase/tests/verify-cloud.mjs` | أمر التحقق الإلزامي `verify:supabase` (قراءة فقط) |
| `supabase/tests/local-pg.ps1` | تشغيل/إيقاف عنقود PostgreSQL معزول للاختبارات |
| `scripts/build-db-seed.mjs` | يعيد توليد `supabase/seed.sql` من `data/content.json` |

## تشغيل الاختبارات

```bash
npm install
npm test                  # اختبارات التطبيق والـAPI الإداري (119)
npm run test:db           # PGlite (جلسة واحدة، 36)
npm run test:db:real      # PostgreSQL محلي حقيقي باتصالين مستقلين (13)
npm run verify:supabase   # تحقق إلزامي من مشروع C-cafe السحابي (قراءة فقط)
```

`npm test` يشغّل اختبارات التطبيق وواجهات الإدارة والـAPI الإداري، ولا يضمّن اختبارات قاعدة البيانات؛ تلك لها أوامر مستقلة.

### اختبارات السحابة (C-cafe)

اختبارات السحابة تعمل على المشروع الحقيقي `mzbhncsdpdbxsdswzruc` فقط، وتتطلب أسرارًا لا تُرفع إلى Git:

| الأمر | ما يثبته | النتيجة |
|---|---|---|
| `node supabase/tests/http-cloud-check.mjs` | `disable_signup`، رفض التسجيل دون إنشاء مستخدم، JWT حقيقي عبر Auth، قراءة الحقول العامة فقط، رفض anon وغير المدير، رفض RPC الإدارة، منع منح المستخدم نفسه صلاحية الإدارة، رفض الكتابة المباشرة، رفض المحتوى غير الصالح | 12/12 |
| `node supabase/tests/pg-cloud-check.mjs` | تزامن اتصالين على PostgreSQL 17.11: حفظ بنفس الإصدار، النشر/الاستعادة مقابل مسودة أحدث، idempotency بـ operation ID، رفض إعادة استخدام المعرّف، إصدار قديم بعد الحذف وإعادة الإنشاء، نتيجة فحص عامة قديمة، الاحتفاظ بـ 50 إصدارًا، وعدم بقاء تغيير جزئي عند فشل المعاملة | 11/11 |
| `npm run verify:supabase` | هوية المشروع وحالته، إغلاق التسجيل، تفعيل دخول البريد، تطابق العرض العام مع `data/content.json`، منع anon من جداول الإدارة ودوالها، وخلو بيانات الاختبار | 6/6 |

الاختباران الأولان يتطلبان ملفات اعتماد مؤقتة (حساب مدير، حساب غير مدير، دور قاعدة بيانات مؤقت) تُنشأ إداريًا ثم تُحذف. لا تُطبع كلمات المرور ولا رموز JWT في المخرجات.

### أمر التحقق الإلزامي `verify:supabase`

```bash
npm run verify:supabase
```

يقرأ المتغيرات التالية، ويفشل بوضوح إذا نقص أي منها (لا يوجد `skip`):

- `CCAFE_PROJECT_REF` — يجب أن يساوي `mzbhncsdpdbxsdswzruc` بالضبط.
- `SUPABASE_URL` — يجب أن يساوي `https://mzbhncsdpdbxsdswzruc.supabase.co`.
- `SUPABASE_ANON_KEY` — المفتاح العام فقط.
- `SUPABASE_ACCESS_TOKEN` — رمز وصول شخصي لقراءة الحالة الإدارية، ولا يُستخدم في التطبيق.

الأمر **لا يستخدم** `service_role` لإثبات الصلاحيات، ولا ينشر محتوى، ولا ينشئ أو يحذف مستخدمين. يرفض العمل على أي Project Ref آخر قبل أي طلب. أمثلة الفشل المتوقعة:

```text
Error: missing required environment variable CCAFE_PROJECT_REF; refusing to skip Supabase verification
Error: refusing project ref wrong-ref; only mzbhncsdpdbxsdswzruc is allowed
```

### PostgreSQL الحقيقي المعزول

الاختبارات الحقيقية تتطلب خادم PostgreSQL محليًا. هذا الجهاز لديه PostgreSQL 16.8 مثبتًا، لذلك أُنشئ **عنقود منفصل تمامًا** بدل استخدام الخدمة الحالية:

- المسار: `%LOCALAPPDATA%\ccafe-pg-verify\data`
- المنفذ: `55432` (وليس 5432)
- المستخدم: `ccafe_admin`
- الاستماع: `127.0.0.1` فقط، ومصادقة `trust` محلية فقط
- الخدمة الحالية على 5432 وبياناتها لم تُلمس

التشغيل والإيقاف:

```powershell
powershell -File supabase/tests/local-pg.ps1 -Action start
powershell -File supabase/tests/local-pg.ps1 -Action status
powershell -File supabase/tests/local-pg.ps1 -Action stop
```

السكربت يرفض المنفذ 5432، ولا يحذف أي بيانات أصلية. اختبارات `pg-real-check.mjs` تنشئ قاعدة جديدة باسم عشوائي لكل سيناريو ثم تحذفها بعد الانتهاء. بيئة الإنتاج الفعلية هي مشروع C-cafe السحابي الموضّح أعلاه.

### النتيجة الكاملة (محدّثة 2026-11-08)

| البيئة | الأمر | النتيجة |
|---|---|---|
| PGlite 0.5.15 (PostgreSQL 18.6 WASM) | `npm run test:db` | 18/18 ناجحة |
| PostgreSQL 16.8 محلي | `npm run test:db:real` | 12/12 ناجحة |
| اختبارات التطبيق والإدارة | `npm test` | 80/80 ناجحة |
| تطابق الصفحة | `renderPage(normalize(data/content.json))` | مطابقة لـ `index.html` (24,891 بايت) |
| Supabase سحابي — HTTP/Auth/PostgREST | `node supabase/tests/http-cloud-check.mjs` | 12/12 ناجحة |
| Supabase سحابي — تزامن PostgreSQL 17.11 | `node supabase/tests/pg-cloud-check.mjs` | 11/11 ناجحة |
| Supabase سحابي — تحقق إلزامي | `npm run verify:supabase` | 6/6 ناجحة |

بيئة التنفيذ: Windows 11، Node.js v24.19.0، npm 11.17.0، PostgreSQL محلي 16.8، عميل `pg` 8.23.1، ومشروع Supabase على PostgreSQL 17.11.

## ما الذي تحاكيه الاختبارات المحلية فعلًا؟

كل من PGlite وPostgreSQL المحلي ينشئان محاكاة دنيا لما يوفره Supabase:

- مخطط `auth` وجدول `auth.users`.
- دالة `auth.uid()` تقرأ `request.jwt.claim.sub` أو `request.jwt.claims -> 'sub'`.
- الدوران `anon` و`authenticated`.
- تبديل الدور بـ `SET ROLE`، ووضع الادعاءات بـ `set_config('request.jwt.claims', ...)`، مثل ما يفعله PostgREST عند تمرير JWT.

هذا يختبر RLS و`GRANT`/`REVOKE` و`SECURITY DEFINER` و`search_path` وحدود RPC. **لكن الاختبارات المحلية وحدها لا تختبر**:

- توقيع JWT والتحقق منه عبر GoTrue.
- طبقة PostgREST وHTTP/Kong.
- سلوك `service_role` الحقيقي.
- نسخة PostgreSQL الدقيقة التي ستشغّلها بيئة Supabase.

اختبار PGlite بجلسة واحدة يحاكي ترتيب جلستين، لكنه ليس إثباتًا للتزامن. اختبار PostgreSQL المحلي يستخدم اتصالين TCP مستقلين، ويستخدم `pg_locks` و`pg_blocking_pids` لترتيب العمليات بدل الاعتماد على تأخير زمني احتمالي.

## ما الذي تثبته اختبارات السحابة فعلًا؟

- **HTTP** (`http-cloud-check.mjs`): GoTrue الحقيقي يصدر JWT موقّعًا، وPostgREST يتحقق منه، وRLS/GRANT تُطبَّق على الطلبات الفعلية. يشمل ذلك رفض التسجيل دون إنشاء مستخدم في `auth.users`، ورفض `anon`، ورفض غير المدير، ورفض RPC الإدارة، ومنع المستخدم من منح نفسه صلاحية الإدارة، ورفض الكتابة المباشرة، ورفض المحتوى غير الصالح.
- **التزامن** (`pg-cloud-check.mjs`): اتصالان مباشران بقاعدة PostgreSQL 17.11 نفسها التي تعمل عليها Supabase. يثبت سلوك الأقفال والقيود عبر معاملات حقيقية متزامنة، وليس عبر محاكاة.
- **التحقق الإلزامي** (`verify-cloud.mjs`): الحالة النهائية للمشروع كما يراها anon والـ Management API، دون أي كتابة.

**ما لا تغطيه الاختبارات المحلية:** طبقة Netlify الحقيقية وGoTrue/PostgREST السحابيين (غطّتها الاختبارات السحابية واختبارات مرحلة النشر/الاستعادة الحية على Draft Deploy)، وStorage، وربط `server.js` المحلي بقاعدة البيانات. أما التحليلات فمغطّاة محليًا في PGlite وPostgreSQL الحقيقي (الإدخال والحدود والعزل والمسح والاحتفاظ)، ويبقى اختبارها الحي عبر Netlify هو الفاصل. استُخدم `service_role` محليًا فقط للتحقق من أن رفض التسجيل لم ينشئ مستخدمًا، وللتنظيف عبر Auth Admin API؛ ولا يوجد في Netlify. اختبارات واجهة الإدارة الثلاثة (حفظ متزامن مع نشر/استعادة، ونشر ناجح ثم فشل تحقق `fallback`) نُفِّذت على harness محلي يستدعي `admin-ui.js` و`admin-api.js` الحقيقيين مع Supabase وهمي وأصل معاينة معترَض؛ تثبت منطق الواجهة والـAPI لكنها لا تثبت سلوك Netlify أو GoTrue/PostgREST السحابي.

## نموذج الصلاحيات

- الجمهور (`anon`) يقرأ **فقط** `public.published_content`، وفيه ثلاثة أعمدة: `version`, `content`, `saved_at`.
- العرض العام `published_content` هو **View** وليس Function أو جدولًا. لا يكشف `saved_by`/`published_by`، ولا `purge_state`، ولا `purge_error`، ولا `public_check_*`، ولا أي بيانات إدارة.
- الجداول الأساسية (`site_content`, `draft`, `content_history`, `admin_users`, `content_operations`, `verification_checks`) عليها RLS. لا توجد سياسات INSERT/UPDATE/DELETE.
- المدير المصادق يقرأ ما تسمح به سياسات SELECT فقط. كل الكتابات تمر عبر RPCs.
- `admin_users` لا يملك سياسة كتابة، ولا توجد دالة «اجعلني مديرًا». المستخدم العادي لا يستطيع منح نفسه الصلاحية.
- دوال `SECURITY DEFINER` تستخدم `search_path = ''` وتؤهل كل كائن بالمخطط. صلاحية `EXECUTE` مسحوبة من `PUBLIC` و`anon`، وممنوحة لـ `authenticated` فقط لدوال الإدارة بعد فحص `admin_users`.
- التحقق من المحتوى موجود داخل قاعدة البيانات (`validate_content` و`assert_content_value`). لا يُعتمد على `normalize` في Netlify كحد أمان، لأن RPC يمكن استدعاؤه مباشرة.

## RPCs

| الدالة | المعنى |
|---|---|
| `admin_save_draft(expected_version, expected_revision, content)` | يحفظ المسودة. `revision_id` يتغير في كل حفظ، وليس فقط عند الإنشاء. |
| `admin_delete_draft(expected_version, expected_revision)` | يحذف المسودة المطابقة فقط. |
| `admin_publish(expected_version, expected_draft_revision, content, note, operation_id)` | ينشر محتوى خامًا أو مراجعة مسودة محددة. يرفض النسخة القديمة والمسودة الأقدم. |
| `admin_restore(history_id, expected_version, note, operation_id)` | ينشئ إصدارًا جديدًا من سجل قديم. لا يحذف أي مسودة. |
| `admin_begin_purge(expected_version, operation_id)` | يسجل طلب إبطال الكاش فقط. |
| `admin_record_purge(version, state, error)` | يسجل نتيجة الإبطال. `accepted` لا يعني أن الزوار يرون النسخة. |
| `admin_begin_public_check(expected_version)` | يبدأ محاولة فحص للصفحة العامة ويسجلها كأحدث محاولة. |
| `admin_finish_public_check(check_id, state, observed_version, detail)` | يسجل النتيجة فقط إذا كانت المحاولة ما زالت الأحدث ولنفس النسخة. |
| `admin_media_create(original_name, declared_mime, declared_bytes)` | ينشئ صف `pending` ومسارًا على الخادم `media/<uuid>`؛ لا يقبل مسارًا من العميل. |
| `admin_media_begin_finalize(asset_id)` | يستحوذ على صف `pending` ويثبت `verification_started_at` قبل قراءة البايتات؛ idempotent، ويرفض المعتمد/غير pending بـ`PT409`. |
| `admin_media_finalize(asset_id, token_sha256, mime, bytes, width, height, pixel_count, sha256)` | يحوّل `pending` مستحوذًا إلى `approved` بعد تحقق خادمي؛ idempotent للمعتمد، ويرفض الصف غير المستحوذ (`PT409`) وتغيير البايتات بعد الاعتماد. |
| `admin_media_fail(asset_id, reason)` | يعلّم `pending` كـ`failed`؛ idempotent، ويرفض الصف المعتمد. |
| `analytics_ingest(token_sha256, env, event, visitor)` | مسار الكتابة الوحيد للأحداث، ممنوح لـ`anon` لكنه يرفض أي قيمة غير `D1` الصحيحة (السر الخام أو البصمة المخزنة `D2` مرفوضان). يعيد التحقق من الحقول والأنواع والأطوال، ويحسب اليوم ببغداد، ويفرض العدّادين المشتركين. |
| `admin_analytics_snapshot(env, range)` | لقطة للمدير فقط: أحداث الفترة والسابقة ولحظية كـJSON، بلا تجميع مخزّن. |
| `admin_analytics_clear(env)` | مسح أحداث وعدادات بيئة واحدة فقط، بصلاحية مدير. |
| `analytics_purge_expired(retention_days)` | تنظيف 90 يومًا للأحداث ويومين للعدادات؛ بلا صلاحية لأي دور API، يُستدعى من `pg_cron`. |

### الوسائط الخاصة و`media/` RLS

- `public.media_assets` يحمل بيانات الأصل: `id`, `storage_path`=`logical_path`=`media/<uuid>`, `status` (`pending`/`approved`/`failed`), `original_name`, `declared_mime`, `declared_bytes`, `verification_started_at` (استحواذ التحقق)، ثم `mime`, `bytes`, `width`, `height`, `sha256`, `finalized_at`, `verified_by` بعد الاعتماد. لا توجد سياسة INSERT/UPDATE/DELETE للجمهور؛ الحالة تتغير عبر RPCs فقط.
- `public.media_secrets` يحمل بصمة SHA-256 الوحيدة للسر الخادمي `CCAFE_MEDIA_FINALIZE_TOKEN`؛ لا يقرأها أي API role، و`EXECUTE` على RPC finalize وحده يستخدمها.
- bucket `ccafe-media` خاص (`public=false`)، وسياسات `storage.objects` تسمح للمدير المصادق بإدخال المسار المطابق لصف `pending` الذي أنشأه فقط (بلا استبدال وبلا استحواذ جارٍ)، وبالقراءة/الحذف ضمن نطاقه. الحذف مسموح فقط لصف `pending`/`failed` للمُنشئ وبلا استحواذ؛ لا تُعدَّل الأصول الأصلية `assets/` ولا تُنسخ.
- الاستحواذ يغلق نافذة TOCTOU: بعد `admin_media_begin_finalize` لا يستطيع أي مسار Storage حذف الكائن أو إعادة رفعه، و`admin_media_finalize` يرفض أي صف بلا استحواذ. `admin_media_fail` يمسح الاستحواذ ليظل تنظيف الملفات المرفوضة ممكنًا.
- `assert_content_value` يقبل `media/<uuid>` فقط إذا كان الصف `approved`؛ `pending` و`failed` والمسارات الملفقة مرفوضة.
- `assert_publishable_media` (داخل `admin_publish` و`admin_restore`) يرفض أي محتوى يحتوي `media/` بـSQLSTATE `CC001`، فيصل عبر الـAPI كـ`422 {error:'private_media'}`. الأصول الأصلية `assets/` تبقى قابلة للنشر.
- تنظيف الملفات المؤقتة: `pending` يُترك صريحًا عبر `admin_media_fail` (abandon) الذي يحذف الكائن عبر Storage API؛ `failed` يحتفظ ببياناته للتدقيق وكائنه يُحذف وقت الفشل. لا حذف تلقائي للصور المعتمدة في هذه المرحلة.

### تحليلات الزوار

- `public.analytics_events` يحتوي صفًا واحدًا لكل حدث مقبول، بالأعمدة: `env`, `day`, `occurred_at`, `visitor`, `session`, `type`, `name`, `kind`, `referrer`, `utm`, `device`, `browser`, `os`, `duration_ms`, `scroll`. لا يوجد عمود IP أو User-Agent أو URL كامل أو كلمة مرور أو JWT أو رابط موقّع. المرجع يُختصر إلى hostname فقط، وutm إلى قيمة منقّحة.
- `visitor` بصمة يومية من الخادم (`HMAC-SHA256(سر الإدخال, "visitor|env|day|ip|ua")` أول 16 hex). لا كوكيز ولا بصمة دائمة، ولا ربط بين يومين أو بين `preview` و`production`.
- `public.analytics_rate_limits` هو العدّاد المشترك: `(env, scope, bucket, window_start)` مفتاح أساسي، و`scope` إما `minute` (120 لكل بصمة زائر) أو `day` (5000 لكل بيئة في يوم بغداد). السقف اليومي **سقف إساءة** لا تدفق متوقع: بقياس الحجم الفعلي للصف والفهارس، 90 يومًا عند 5000 يوميًا ≈ 450 ألف صف (~245MB)، بينما السقف القديم 200000 كان يعني ~9.8GB ولا يتسع للمشروع على الخطة المجانية. الزيادة ذرّية عبر `ON CONFLICT ... DO UPDATE`، فنسختان من Function تريان العدّاد نفسه. الطلب المرفوض يستهلك العدّاد أيضًا كي لا يتحول الرفض إلى حلقة إعادة محاولة.
- `public.analytics_secrets` يحمل `D2 = SHA-256("ingest|" + D1)` حيث `D1 = SHA-256("ingest|" + CCAFE_ANALYTICS_INGEST_TOKEN)`؛ أي أن السر الخام لا يصل إلى القاعدة، والقيمة التي ترسلها الدالة (`D1`) لا تُخزَّن. `analytics_ingest` يعيد تجزئة القيمة الواردة قبل المقارنة، لذلك إعادة استخدام `D2` المخزنة أو إرسال السر الخام مرفوضة بـ`42501` قبل أي كتابة أو استهلاك للعدّاد. لا يقرأ الجدول أي دور API، ولا يُخزَّن السر الخام في القاعدة أو PostgREST أو السجلات.
- ملفات الترحيل تحتوي قيمًا وهمية خاملة فقط في `analytics_secrets` و`media_secrets`، وليس بصمات أي سر حي. عند تثبيت جديد، ولّد السرّين وحدّث الصفّين معًا، أو حمّل صفوف النسخة الاحتياطية بعد تطبيق الترحيلات. عند الاستعادة، تُحمَّل صفوف `analytics_secrets` و`media_secrets` من `db/tables/` بعد الترحيلات؛ لا تعتمد على القيم الموجودة في ملفات الترحيل.
- الجداول الثلاثة عليها RLS بلا سياسات، و`SELECT/INSERT/UPDATE/DELETE` مسحوبة من `anon` و`authenticated`. الاستدعاء المباشر لـ`analytics_ingest` بلا بصمة صحيحة مرفوض؛ ولا يستطيع غير المدير قراءة اللقطة أو المسح حتى لو استدعى RPC مباشرة.
- العزل: كل صف وعدّاد يحمل `env` (`preview` أو `production`)، والدالة تُمرِّر بيئتها من الخادم؛ لا يختار العميل `env` في اللوحة ولا في الإدخال. المسح يخص بيئة واحدة ولا يمس المحتوى أو السجل أو الصور.
- الاحتفاظ: 90 يومًا فقط للأحداث الخام، ويومان للعدادات. لا جداول تجميع ولا احتفاظ أطول. الترحيل يحاول جدولة `pg_cron` باسم `ccafe_analytics_purge` يوميًا 03:15 UTC إن كان الامتداد مثبتًا، ويتجاهل الجدولة بأمان إن لم يكن. للتعطيل: `select cron.unschedule('ccafe_analytics_purge');` أو تعطيل `CCAFE_ANALYTICS_ENV` على النشر.

### التزامن وترتيب الأقفال

كل عملية تحوير تأخذ قفلًا استشاريًا واحدًا ثم تقفل الصفوف بهذا الترتيب:

```text
pg_advisory_xact_lock
  -> site_content
  -> draft
  -> content_history / content_operations
```

- `revision_id` للمسودة يتغير في كل حفظ، ولا يُعاد استخدامه بعد الحذف وإعادة الإنشاء.
- النشر يحذف فقط المسودة التي طابقت `expected_draft_revision`، لذلك لا يحذف مسودة أحدث.
- النشر والاستعادة يتحققان من `expected_version`.
- `content_operations` يخزّن بصمة الطلب (`request`) بجانب النتيجة. إعادة إرسال نفس `operation_id` بنفس الطلب تعيد النتيجة الأصلية، وإعادة استخدامه بمحتوى أو ملاحظة أو نسخة متوقعة أو نوع مختلف **تُرفض** بدل أن تُعامَل كإعادة محاولة.
- `content_history` يحتفظ بآخر 50 إصدارًا. الاستعادة تُضاف كإصدار جديد ثم يُقصّ السجل إلى 50.

### الاحتفاظ بـ `content_operations`

- `content_operations` جدول إيصالات idempotency: يربط `operation_id` ببصمة الطلب والنتيجة، ليعيد النشر أو الاستعادة النتيجة نفسها عند إعادة المحاولة بعد انقطاع الرد.
- صفوفه **لا تُحذف تلقائيًا**. الحذف الوحيد الذي جرى كان يدويًا ومقصودًا لسجلات عمليات حسابات اختبار مؤقتة، قبل حذف تلك الحسابات، لأن `actor_id` عليه `ON DELETE RESTRICT`؛ وهو ليس سياسة إنتاجية ولا آلية دورية، ولم يمس `content_history` أو `verification_checks`.
- سياسة مقترحة: الإبقاء عليها بلا حذف آلي. إن لزم التقليم مستقبلًا، فبعد مدة أطول من أفق أي إعادة محاولة معقولة (مثلًا 90 يومًا) وبأمر صريح مُدقَّق، مع إبقاء صفوف العمليات المرتبطة بإصدارات ما تزال موجودة في `content_history`.
- أثر الحذف على إعادة محاولة عملية قديمة: بعد حذف صف `operation_id`، لم يعد الخادم يتعرف على الطلب كإعادة محاولة. إن كانت `expected_version` و`expected_draft_revision` ما زالت مطابقة، فقد تُنشئ إعادة الإرسال إصدارًا جديدًا (تكرارًا)، وإلا فترجّح 409. لذلك الحذف قبل انتهاء أفق إعادة المحاولة يلغي ضمان idempotency لتلك العملية.

### الإبطال وفحص الصفحة

- `site_content.version` هو إصدار المحتوى **المحفوظ**، وليس ادعاءً بأنه ظاهر لكل الزوار.
- `purge_state` منفصل: `pending`, `requested`, `accepted`, `failed`. `accepted` يعني قبول طلب الإبطال فقط.
- `public_check_state` و`public_check_observed_version` منفصلان كذلك.
- كل فحص جديد يسجل `public_check_id` فورًا. إن وصلت نتيجة فحص قديم بعد بدء فحص أحدث، أو بعد نشر إصدار أحدث، تُسجل للمراجعة لكنها لا تكتب فوق الحالة الحالية.
- الصفحة العامة يجب أن تحمل رقم الإصدار (مثل `<meta name="ccafe-content-version" content="N">`) حتى يستطيع الفحص مقارنته. فحص واحد لا يثبت ظهور النسخة لكل الزوار أو لكل حواف الكاش.

## البذرة

`supabase/seed.sql` مولّد من `data/content.json`. لإعادة توليده بعد تعديل المحتوى المحلي:

```bash
node scripts/build-db-seed.mjs
```

البذرة idempotent للإصدار 1: إعادة تطبيقها لا تنشئ صفوفًا مكررة. وهي لا تنشئ مستخدمي auth ولا مشرفين. طُبِّقت البذرة على مشروع C-cafe ثم تقدّم رقم الإصدار أثناء الاختبارات، ثم أُعيد المحتوى الأصلي كإصدار جديد؛ لذلك رقم الإصدار الحالي ليس 1.

## عائق Supabase المحلي الكامل

Supabase CLI موجود عبر `npx`، لكن `supabase start` المحلي يحتاج Docker، وDocker يحتاج WSL2، وكلاهما غير مثبت على هذا الجهاز. محاولة `supabase db lint` أعطت:

```text
Target: local stack (127.0.0.1:54322)
DbConnectError: connect ECONNREFUSED 127.0.0.1:54322
suggestion: Make sure Docker is running, then run: supabase start
```

هذه بيئة ناقصة، وليست نتيجة فشل في المخطط. لا حاجة لتجاوزها لإكمال هذه المرحلة، لأن اختبارات PostgREST/GoTrue نُفِّذت على السحابة الحقيقية. من يريد المكدس المحلي الكامل يحتاج:

1. افتح PowerShell **كمسؤول**.
2. `wsl --install -d Ubuntu` ثم أعد تشغيل الجهاز.
3. ثبّت Docker Desktop، وفعّل `Use the WSL 2 based engine`، ثم شغّله.
4. تحقق: `docker version` و`docker info`.
5. من المشروع: `npx supabase@latest init` ثم `npx supabase@latest start`.

## قيود معروفة

- **دور CLI العالق:** أثناء `db push` أنشأ Supabase CLI دورًا مؤقتًا باسم `cli_login_postgres` عبر `supabase_admin`. الـ Management API ينفّذ كـ `postgres`، وهو يملك `CREATEROLE` لكن ليس `ADMIN OPTION` على هذا الدور، لذلك `DROP ROLE` يفشل بـ `ERROR 42501`. عُطِّل الدور (`NOLOGIN`) وأُبقي على حاله؛ لا توجد بيانات اعتماد متاحة لـ `supabase_admin` لحذفه نهائيًا. الأمر `verify:supabase` يتحقق فقط من أن الدور **لا يستطيع تسجيل الدخول**، ولا يعتبره فشلًا.
- **نسخة العنوان:** `site_content.version` ليست 1 بعد الاختبارات. أُعيد المحتوى الأصلي كإصدار جديد، ولم تُعدَّ أرقام الإصدارات إلى الوراء.
- **طبقة الإنتاج:** المشروع السحابي مربوط بـNetlify ولوحة `/admin/` عبر دوال وRPCs محمية، لكن `server.js` المحلي ما زال غير مربوط، ولا يوجد نشر إنتاجي أو حساب مدير نهائي.

## ما لم يُنفَّذ في هذه المرحلة

- تحليلات الزوار نُفِّذت على المعاينة فقط (`CCAFE_ANALYTICS_ENV=preview` وDraft Deploy)، وبقيت الإنتاج معطّلة عمدًا؛ لا حذف صور معتمدة من الواجهة، ولا نشر للصور المرفوعة إلى الموقع العام، ولا ربط لـ`server.js` المحلي بقاعدة البيانات. Storage الخاص للوسائط هو ما نُفِّذ.
- لا نشر إنتاجي ولا دومين مخصص ولا حساب مدير نهائي.
- لا تعديل للمشروع السابق، ولا ترقية مدفوعة، ولا تغيير في التصميم العام.
- لا commit ولا push.
