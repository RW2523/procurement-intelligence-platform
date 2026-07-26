-- =============================================================================
-- Procurement sources. Idempotent: re-running updates URLs/names in place and
-- never duplicates (slug is unique) and never resets a source's crawl history.
--
-- connector_key maps to src/lib/connectors/registry.ts. A source whose key is
-- absent from that map is kept with status 'needs_connector': tracked and
-- visible in the UI, but skipped by the crawler.
-- =============================================================================

insert into public.sources (name, slug, state, base_url, connector_type, connector_key, status, notes) values
  -- REQUIRED by the "My Bids" feature: every manually-added bid is attached to
  -- this row. Without it the page shows its empty state forever and "Add a bid"
  -- fails, because getSourceBySlug('manual') returns null.
  ('Manually added', 'manual', null,
   'https://example.invalid/manual', 'custom', null, 'paused',
   'Not a crawl target. Container for bids entered by hand (My Bids).'),

  ('SAM.gov (Federal)', 'sam', 'US',
   'https://sam.gov/', 'json_api', 'sam', 'active',
   'Federal contract opportunities. Requires SAM_GOV_API_KEY.'),

  ('Texas SmartBuy / ESBD', 'tx', 'TX',
   'https://www.txsmartbuy.gov/esbd', 'static_html', 'tx', 'active',
   'Electronic State Business Daily. Contracts browse: https://www.txsmartbuy.gov/browsecontracts'),

  ('Missouri (Oracle Fusion)', 'mo', 'MO',
   'https://ewqg.fa.us8.oraclecloud.com/fscmUI/redwood/negotiation-abstracts/view/abstractlisting?prcBuId=300000005255687',
   'json_api', 'mo', 'active', 'Oracle Fusion negotiation abstracts.'),

  ('North Dakota (NDBuys)', 'nd', 'ND',
   'https://public.ndbuys.nd.gov/page.aspx/en/rfp/request_browse_public', 'custom', null, 'needs_connector',
   'DELIBERATELY NOT CRAWLED: Ivalua portal behind a browser check + reCAPTCHA Enterprise, and robots.txt disallows the bid paths. Needs an official feed or manual entry.'),

  ('South Dakota', 'sd', 'SD',
   'https://www.sd.gov/bhra?id=cs_kb_article_view&sysparm_article=KB0044787', 'static_html', 'sd', 'active',
   'ServiceNow knowledge article listing solicitations.'),

  ('Montana (SciQuest/Jaggaer)', 'mt', 'MT',
   'https://bids.sciquest.com/apps/Router/PublicEvent?CustomerOrg=StateOfMontana', 'static_html', 'mt', 'active', null),

  ('Kentucky (VSS)', 'ky', 'KY',
   'https://vss.ky.gov/vssprod-ext/Advantage4', 'static_html', 'ky', 'active',
   'CGI Advantage VSS — published solicitations.'),

  ('Wyoming (Public Purchase)', 'wy', 'WY',
   'https://www.publicpurchase.com/gems/wyominggsd,wy/buyer/public/publicInfo', 'static_html', 'wy', 'active', null),

  ('Mississippi DFA', 'ms', 'MS',
   'https://www.dfa.ms.gov/bids-and-rfps-notices', 'static_html', 'ms', 'active', null),

  ('West Virginia Purchasing', 'wv', 'WV',
   'https://www.state.wv.us/admin/purchase/Awards/awarded.html', 'static_html', 'wv', 'active', null),

  ('Alaska (IRIS VSS)', 'ak', 'AK',
   'https://iris-vss.alaska.gov/', 'static_html', 'ak', 'active',
   'CGI Advantage VSS — published solicitations.'),

  ('Kansas (PeopleSoft)', 'ks', 'KS',
   'https://supplier.sok.ks.gov/psc/sokfsprdsup/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL',
   'static_html', 'ks', 'active', null),

  ('Oklahoma (PeopleSoft)', 'ok', 'OK',
   'https://financials.ok.gov/psc/SOKLFP1DS/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL',
   'static_html', 'ok', 'active', null),

  ('City of Phoenix (OpenGov)', 'phx', 'AZ',
   'https://procurement.opengov.com/portal/phoenix', 'json_api', 'phx', 'active', null),

  ('Louisiana LaPAC', 'la', 'LA',
   'https://wwwcfprd.doa.louisiana.gov/osp/lapac/deptbids.cfm', 'static_html', 'la', 'active', null),

  ('Arkansas Procurement', 'ar', 'AR',
   'https://www.arkansas.gov/tss/procurement/bids/index.php', 'static_html', 'ar', 'active', null),

  ('Pennsylvania eMarketplace', 'pa', 'PA',
   'https://www.emarketplace.state.pa.us/Search.aspx', 'aspnet_viewstate', 'pa', 'active', null),

  ('Tennessee CPO', 'tn', 'TN',
   'https://www.tn.gov/content/tn/generalservices/procurement/central-procurement-office--cpo-/supplier-information/request-for-proposals--rfp--opportunities1.html',
   'static_html', 'tn', 'active', null),

  ('North Carolina eVP', 'nc', 'NC',
   'https://evp.nc.gov/solicitations/?status=0', 'static_html', 'nc', 'active', null),

  ('Massachusetts COMMBUYS', 'ma', 'MA',
   'https://www.commbuys.com/bso/view/search/external/advancedSearchBid.xhtml?openBids=true',
   'jsf_playwright', 'ma', 'active',
   'Page 1 is fetched statically. Deeper pagination needs PLAYWRIGHT_ENABLED=true, which we keep off on the shared 2 GB box.')

on conflict (slug) do update set
  name           = excluded.name,
  state          = excluded.state,
  base_url       = excluded.base_url,
  connector_type = excluded.connector_type,
  connector_key  = excluded.connector_key,
  notes          = excluded.notes,
  updated_at     = now();
  -- status is deliberately NOT overwritten: a source paused or errored by the
  -- operator/crawler keeps that state across re-seeds.

select state, slug, status from public.sources order by (slug = 'sam') desc, state;
