-- NEXORA AI · 0600 · Datos de referencia obligatorios (monedas, reglas, catálogo semántico) y bucket privado.
-- Es migración (no semilla) porque 'supabase db push' en un proyecto hospedado no ejecuta semillas.


insert into core.currencies (code, name, decimals) values
  ('USD', 'Dólar estadounidense', 2), ('GTQ', 'Quetzal guatemalteco', 2), ('HNL', 'Lempira hondureño', 2),
  ('CRC', 'Colón costarricense', 2), ('MXN', 'Peso mexicano', 2), ('EUR', 'Euro', 2);

insert into core.countries (code, name, default_currency) values
  ('GT', 'Guatemala', 'GTQ'), ('HN', 'Honduras', 'HNL'), ('SV', 'El Salvador', 'USD'),
  ('PA', 'Panamá', 'USD'), ('CR', 'Costa Rica', 'CRC'), ('MX', 'México', 'MXN');

-- ---------------------------------------------------------------- reglas de validación (versión 1)
insert into silver.validation_rules (code, name, description, severity, scope) values
  ('DUPLICATE_FILE', 'Archivo repetido', 'El mismo contenido (SHA-256) ya se cargó para la empresa', 'informational', 'file'),
  ('DUPLICATE_ROW', 'Registro duplicado', 'Dos o más filas con la misma cuenta, periodo, importe, moneda, contraparte y referencia en la misma versión', 'critical', 'line'),
  ('INVALID_AMOUNT', 'Importe inválido', 'El importe está vacío o no es numérico', 'critical', 'line'),
  ('INCONSISTENT_SIGN', 'Importe inconsistente', 'El signo del importe contradice la naturaleza presupuestaria de la cuenta', 'warning', 'line'),
  ('UNKNOWN_ACCOUNT', 'Cuenta inexistente', 'La cuenta no existe en el catálogo de la empresa', 'critical', 'line'),
  ('UNMAPPED_ACCOUNT', 'Cuenta sin homologación', 'La cuenta de la empresa no tiene un mapeo aprobado al catálogo corporativo', 'critical', 'line'),
  ('UNKNOWN_CURRENCY', 'Moneda desconocida', 'El código de moneda no existe en el catálogo', 'critical', 'line'),
  ('CURRENCY_MISMATCH', 'Movimiento inconsistente', 'La moneda del registro difiere de la moneda funcional de la empresa', 'critical', 'line'),
  ('INVALID_PERIOD', 'Periodo incorrecto', 'El periodo no se puede interpretar o no pertenece al ejercicio de la versión', 'critical', 'line'),
  ('UNKNOWN_COMPANY', 'Empresa inexistente', 'El código de empresa del registro no corresponde a la empresa de la carga', 'critical', 'line'),
  ('MISSING_FX_RATE', 'Tasa de cambio faltante', 'No existe una tasa aprobada para la moneda, tipo, periodo y escenario requeridos', 'critical', 'version'),
  ('IC_COUNTERPARTY_UNKNOWN', 'Contraparte intercompañía no identificada', 'La contraparte no es una empresa del grupo', 'critical', 'line'),
  ('IC_MISSING_COUNTERPARTY', 'Cuenta intercompañía sin contraparte', 'Una cuenta intercompañía requiere contraparte y referencia', 'critical', 'line'),
  ('IC_UNMATCHED', 'Operación intercompañía sin contrapartida', 'No se encontró la operación recíproca en la empresa contraparte', 'critical', 'version'),
  ('IC_MISMATCH', 'Descuadre intercompañía', 'Los importes recíprocos difieren más allá de la tolerancia aprobada', 'critical', 'version'),
  ('MISSING_COMPANY_FILE', 'Empresa sin carga', 'Una empresa activa no tiene carga procesada para la versión', 'warning', 'version');

-- ---------------------------------------------------------------- catálogo semántico
insert into semantic.metrics (code, name, description, unit, category, kind, higher_is_better) values
  ('revenue', 'Ingresos consolidados', 'Ingresos por ventas e intercompañía, netos de eliminaciones intercompañía', 'currency', 'resultado', 'base', true),
  ('costs', 'Costos consolidados', 'Costo de ventas netos de eliminaciones intercompañía', 'currency', 'resultado', 'base', false),
  ('opex', 'Gastos operativos', 'Sueldos, arrendamientos, mercadeo, servicios y otros gastos operativos, netos de eliminaciones', 'currency', 'resultado', 'base', false),
  ('ebitda', 'EBITDA', 'Resultado antes de intereses, impuestos, depreciación y amortización', 'currency', 'resultado', 'derived', true),
  ('ebit', 'EBIT', 'Resultado operativo', 'currency', 'resultado', 'derived', true),
  ('net_income', 'Utilidad neta', 'Resultado después de intereses, diferencias IC e impuestos', 'currency', 'resultado', 'derived', true),
  ('nopat', 'NOPAT', 'Resultado operativo después de impuestos', 'currency', 'rentabilidad', 'derived', true),
  ('invested_capital', 'Capital invertido promedio', 'Promedio de apertura y cierre de deuda + patrimonio + CTA − efectivo', 'currency', 'capital', 'derived', true),
  ('capital_employed', 'Capital empleado promedio', 'Promedio de apertura y cierre de activos totales − pasivos corrientes', 'currency', 'capital', 'derived', true),
  ('roic', 'ROIC', 'Rendimiento sobre el capital invertido', 'ratio', 'rentabilidad', 'derived', true),
  ('roce', 'ROCE', 'Rendimiento sobre el capital empleado', 'ratio', 'rentabilidad', 'derived', true),
  ('wacc', 'WACC', 'Costo promedio ponderado de capital con pesos contables al cierre', 'ratio', 'rentabilidad', 'derived', false),
  ('eva', 'EVA', 'Valor económico agregado', 'currency', 'rentabilidad', 'derived', true),
  ('ebitda_margin', 'Margen EBITDA', 'EBITDA / ingresos', 'ratio', 'margen', 'derived', true),
  ('operating_margin', 'Margen operativo', 'EBIT / ingresos', 'ratio', 'margen', 'derived', true),
  ('revenue_share', 'Participación en ingresos', 'Contribución de cada empresa a los ingresos consolidados (después de eliminaciones atribuidas)', 'ratio', 'estructura', 'derived', true),
  ('ic_elimination_impact', 'Impacto de eliminaciones intercompañía', 'Suma de eliminaciones aplicadas sobre ingresos', 'currency', 'consolidación', 'base', true),
  ('fx_effect', 'Efecto cambiario', 'Parte de la variación en moneda de grupo explicada por el cambio de tasas frente a la versión de comparación', 'currency', 'variación', 'derived', true);

insert into semantic.metric_versions (metric_code, version, formula, strategy, components, aggregation, status, approved_at) values
  ('revenue', 1, 'Σ cuentas categoría revenue (traducción + eliminaciones + ajustes)', 'sum_category', '["revenue"]', 'sum', 'approved', now()),
  ('costs', 1, 'Σ cuentas categoría cogs', 'sum_category', '["cogs"]', 'sum', 'approved', now()),
  ('opex', 1, 'Σ cuentas categoría opex', 'sum_category', '["opex"]', 'sum', 'approved', now()),
  ('ebitda', 1, 'revenue − costs − opex', 'ebitda', '["revenue","cogs","opex"]', 'recalculate_from_components', 'approved', now()),
  ('ebit', 1, 'EBITDA − depreciación y amortización', 'ebit', '["revenue","cogs","opex","da"]', 'recalculate_from_components', 'approved', now()),
  ('net_income', 1, 'EBIT − gasto financiero − diferencias IC − impuesto', 'net_income', '["revenue","cogs","opex","da","interest","other","tax"]', 'recalculate_from_components', 'approved', now()),
  ('nopat', 1, 'EBIT × (1 − nopat_tax_rate)', 'nopat', '["ebit","param:nopat_tax_rate"]', 'recalculate_from_components', 'approved', now()),
  ('invested_capital', 1, '((deuda + patrimonio + CTA − efectivo)apertura + (…)cierre) / 2', 'invested_capital', '["bs:debt","bs:equity","bs:cash"]', 'average_balances', 'approved', now()),
  ('capital_employed', 1, '((efectivo + CxC + inventario + PPE − CxP)apertura + (…)cierre) / 2', 'capital_employed', '["bs:cash","bs:receivables","bs:ppe","bs:payables"]', 'average_balances', 'approved', now()),
  ('roic', 1, 'NOPAT / capital invertido promedio', 'roic', '["nopat","invested_capital"]', 'recalculate_from_components', 'approved', now()),
  ('roce', 1, 'EBIT / capital empleado promedio', 'roce', '["ebit","capital_employed"]', 'recalculate_from_components', 'approved', now()),
  ('wacc', 1, 'E/(D+E)·Ke + D/(D+E)·Kd·(1 − t)   con E = patrimonio + CTA y D = deuda al cierre', 'wacc', '["bs:debt","bs:equity","param:cost_of_equity","param:cost_of_debt","param:nopat_tax_rate"]', 'recalculate_from_components', 'approved', now()),
  ('eva', 1, 'NOPAT − capital invertido promedio × WACC', 'eva', '["nopat","invested_capital","wacc"]', 'recalculate_from_components', 'approved', now()),
  ('ebitda_margin', 1, 'EBITDA / revenue', 'ebitda_margin', '["ebitda","revenue"]', 'recalculate_from_components', 'approved', now()),
  ('operating_margin', 1, 'EBIT / revenue', 'operating_margin', '["ebit","revenue"]', 'recalculate_from_components', 'approved', now()),
  ('revenue_share', 1, '(ingresos traducidos de la empresa + eliminaciones atribuidas) / ingresos consolidados', 'revenue_share', '["revenue"]', 'ratio_of_sums', 'approved', now()),
  ('ic_elimination_impact', 1, 'Σ asientos de eliminación sobre cuentas de ingreso', 'ic_elimination_impact', '["revenue"]', 'sum', 'approved', now()),
  ('fx_effect', 1, 'Σ local_B × (tasa_B − tasa_A) sobre ingresos', 'fx_effect', '["revenue","rates:A","rates:B"]', 'variance_bridge', 'approved', now());

insert into semantic.dimensions (code, name, description) values
  ('company', 'Empresa', 'Empresa del grupo (cifras individuales traducidas, antes de eliminaciones salvo indicación)'),
  ('country', 'País', 'País de la empresa'),
  ('period', 'Mes', 'Periodo mensual del ejercicio'),
  ('account', 'Cuenta corporativa', 'Cuenta del catálogo homologado del grupo');

insert into semantic.metric_dimensions (metric_code, dimension_code)
select m, d from (values ('revenue'), ('costs'), ('opex'), ('ebitda'), ('ebit'), ('net_income'), ('ic_elimination_impact')) a(m)
cross join (values ('company'), ('country'), ('period')) b(d);
insert into semantic.metric_dimensions (metric_code, dimension_code) values
  ('revenue', 'account'), ('costs', 'account'), ('opex', 'account');
insert into semantic.metric_dimensions (metric_code, dimension_code)
select m, d from (values ('nopat'), ('invested_capital'), ('capital_employed'), ('roic'), ('roce'), ('wacc'), ('eva'),
                         ('ebitda_margin'), ('operating_margin'), ('revenue_share'), ('fx_effect')) a(m)
cross join (values ('company'), ('country')) b(d);
insert into semantic.metric_dimensions (metric_code, dimension_code) values
  ('ebitda_margin', 'period'), ('operating_margin', 'period'), ('fx_effect', 'period');

insert into semantic.semantic_relationships (from_metric, to_metric, relation) values
  ('revenue', 'ebitda', 'component_of'), ('costs', 'ebitda', 'component_of'), ('opex', 'ebitda', 'component_of'),
  ('ebitda', 'ebit', 'component_of'), ('ebit', 'nopat', 'component_of'), ('nopat', 'roic', 'component_of'),
  ('invested_capital', 'roic', 'component_of'), ('ebit', 'roce', 'component_of'), ('capital_employed', 'roce', 'component_of'),
  ('nopat', 'eva', 'component_of'), ('invested_capital', 'eva', 'component_of'), ('wacc', 'eva', 'component_of'),
  ('ebitda', 'ebitda_margin', 'component_of'), ('revenue', 'ebitda_margin', 'component_of'),
  ('ebit', 'operating_margin', 'component_of'), ('revenue', 'operating_margin', 'component_of');

insert into semantic.synonyms (term, target_type, target_code) values
  ('ingresos', 'metric', 'revenue'), ('ingreso', 'metric', 'revenue'), ('ventas', 'metric', 'revenue'), ('revenue', 'metric', 'revenue'),
  ('costos', 'metric', 'costs'), ('costo de ventas', 'metric', 'costs'), ('costo', 'metric', 'costs'),
  ('gastos operativos', 'metric', 'opex'), ('gastos', 'metric', 'opex'), ('opex', 'metric', 'opex'),
  ('ebitda', 'metric', 'ebitda'), ('ebit', 'metric', 'ebit'), ('utilidad operativa', 'metric', 'ebit'), ('resultado operativo', 'metric', 'ebit'),
  ('utilidad neta', 'metric', 'net_income'), ('resultado neto', 'metric', 'net_income'),
  ('nopat', 'metric', 'nopat'), ('capital invertido', 'metric', 'invested_capital'), ('capital empleado', 'metric', 'capital_employed'),
  ('roic', 'metric', 'roic'), ('rendimiento sobre capital invertido', 'metric', 'roic'),
  ('roce', 'metric', 'roce'), ('eva', 'metric', 'eva'), ('valor económico agregado', 'metric', 'eva'), ('valor economico agregado', 'metric', 'eva'),
  ('wacc', 'metric', 'wacc'), ('costo de capital', 'metric', 'wacc'),
  ('margen ebitda', 'metric', 'ebitda_margin'), ('margen operativo', 'metric', 'operating_margin'),
  ('participación', 'metric', 'revenue_share'), ('participacion', 'metric', 'revenue_share'),
  ('eliminaciones', 'metric', 'ic_elimination_impact'), ('intercompany', 'metric', 'ic_elimination_impact'), ('intercompañía', 'metric', 'ic_elimination_impact'),
  ('impacto cambiario', 'metric', 'fx_effect'), ('efecto cambiario', 'metric', 'fx_effect'), ('tipo de cambio', 'metric', 'fx_effect'),
  ('empresa', 'dimension', 'company'), ('empresas', 'dimension', 'company'), ('compañía', 'dimension', 'company'), ('compañías', 'dimension', 'company'),
  ('país', 'dimension', 'country'), ('pais', 'dimension', 'country'), ('países', 'dimension', 'country'),
  ('mes', 'dimension', 'period'), ('mensual', 'dimension', 'period'), ('meses', 'dimension', 'period'), ('cuenta', 'dimension', 'account'), ('cuentas', 'dimension', 'account'),
  ('barras', 'chart', 'bar'), ('barra', 'chart', 'bar'), ('columnas', 'chart', 'bar'), ('líneas', 'chart', 'line'), ('linea', 'chart', 'line'), ('línea', 'chart', 'line'),
  ('área', 'chart', 'area'), ('area', 'chart', 'area'), ('pastel', 'chart', 'donut'), ('dona', 'chart', 'donut'), ('torta', 'chart', 'donut'),
  ('tabla', 'chart', 'table'), ('kpi', 'chart', 'kpi'), ('tarjeta', 'chart', 'kpi'), ('cascada', 'chart', 'waterfall'),
  ('mapa de calor', 'chart', 'heatmap'), ('apiladas', 'chart', 'stacked_bar'), ('apilado', 'chart', 'stacked_bar');

-- ---------------------------------------------------------------- Storage: bucket privado de archivos originales (Bronze)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('budget-files', 'budget-files', false, 20971520,
        array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'text/plain'])
on conflict (id) do update set public = false;
-- Sin políticas en storage.objects para anon/authenticated: solo el servidor (clave secreta) lee y escribe.
