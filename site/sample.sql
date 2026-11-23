CREATE OR REPLACE TABLE input AS SELECT
  i + 1001 AS "订单编号",
  CASE WHEN i % 11 = 0 THEN NULL ELSE round(20 + (i % 17) * 8.75, 2)::DOUBLE END AS "金额",
  1 + i % 5 AS "件数",
  CASE WHEN i % 13 = 0 THEN NULL ELSE ['线上', '门店', '合作伙伴'][1 + i % 3] END AS "渠道",
  ['华东', '华西', '华北', '华南'][1 + i % 4] AS "地区",
  DATE '2026-11-01' + (i % 21)::INTEGER AS "下单日期",
  i % 5 <> 0 AS "已发货",
  ['请查物流', 'Gift box / 需加急', '送达门店'][1 + i % 3] AS "客服备注",
  CASE WHEN i % 9 = 0 THEN '待核对' ELSE (DATE '2026-11-03' + (i % 21)::INTEGER)::VARCHAR END AS "签收日期原文",
  'https://example.com/track/' || (i % 5) || '?source=orders#status' AS "物流链接",
  '/orders/' || (i % 4) || '/receipt.txt' AS "归档路径",
  'receipt.txt' AS "附件",
  'product.png' AS "商品图片",
  CASE WHEN i % 13 = 0 THEN NULL ELSE 25 + 4 * sin(i * 0.7) + i % 5 END AS "处理时长"
FROM range(128) t(i)
