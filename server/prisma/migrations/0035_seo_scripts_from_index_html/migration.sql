-- Move the hard-coded tracking tags out of index.html and into the admin-managed
-- `seo.scripts` setting (Admin → Settings → SEO & Scripts), so every head/body/
-- footer snippet lives in one place an admin can edit without a code deploy.
--
-- The same three tags that were previously inlined in index.html are seeded here
-- VERBATIM — GTM container GTM-MGM4L8SG, GA4 gtag G-YV6WEQRGJP, and the Meta
-- Pixel 2981668052172302 with its production-host guard intact. Without this the
-- tags would simply disappear the moment the new index.html ships and every
-- conversion would stop being recorded.
--
-- ON CONFLICT DO NOTHING, not an upsert: if an admin has already saved anything
-- into these fields, their value is the live one and must win. This migration
-- only fills the row in when it does not exist yet.
--
-- Values are dollar-quoted and assembled with json_build_object so the snippets'
-- own quotes need no escaping and the stored text is guaranteed-valid JSON (the
-- server JSON.parses this column — see server/src/services/seo.ts).
--
-- Idempotent (see server/MIGRATIONS.md).

INSERT INTO "platform_settings" ("key", "value", "isSecret", "updatedAt")
VALUES (
  'seo.scripts',
  json_build_object(
    'head', $js$<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-MGM4L8SG');</script>
<!-- End Google Tag Manager -->
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-YV6WEQRGJP"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-YV6WEQRGJP');
</script>
<!-- Meta Pixel Code — production hosts only (skips staging, localhost, previews) -->
<script>
  (function () {
    var PROD_HOSTS = ['hello22.ai', 'www.hello22.ai', 'app.hello22.ai'];
    if (PROD_HOSTS.indexOf(window.location.hostname) === -1) return;
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '2981668052172302');
    fbq('track', 'PageView');
  })();
</script>
<!-- End Meta Pixel Code -->$js$,
    'body', $js$<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MGM4L8SG"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
<!-- Meta Pixel Code (noscript) -->
<noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=2981668052172302&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code (noscript) -->$js$,
    'footer', ''
  )::text,
  false,
  NOW()
)
ON CONFLICT ("key") DO NOTHING;
