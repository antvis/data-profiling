CREATE OR REPLACE TABLE input AS SELECT
  i + 1001 AS "订单编号",
  CASE WHEN i % 11 = 0 THEN NULL ELSE round(20 + (i % 17) * 8.75, 2)::DOUBLE END AS "金额",
  1 + i % 5 AS "件数",
  CASE WHEN i % 13 = 0 THEN NULL ELSE ['线上', '门店', '合作伙伴'][1 + i % 3] END AS "渠道",
  ['华东', '华西', '华北', '华南'][1 + i % 4] AS "地区",
  DATE '2026-11-01' + (i % 21)::INTEGER AS "下单日期"
FROM range(128) t(i)
