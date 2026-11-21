# Reglas financieras

Implementación: `packages/financial-engine` (TypeScript, `decimal.js` a 34 dígitos). Verificación independiente: `scripts/expected_results.py` (Python `Decimal`), sin código compartido.

## 1. Convención de signos

Los presupuestos se registran en **signo natural positivo**: ingresos, costos, gastos, activos, pasivos y patrimonio > 0. La regla `INCONSISTENT_SIGN` advierte importes negativos en cuentas de ingreso, costo, gasto, CxC, inventario, PPE, CxP y deuda.

## 2. Homologación

Cada línea se asocia a una cuenta corporativa solo mediante un mapeo **aprobado** (`silver.account_mappings`). Una cuenta sin mapeo nunca se consolida (`UNMAPPED_ACCOUNT` / `UNKNOWN_ACCOUNT`, críticas).

## 3. Conversión de moneda

| Tipo de cuenta | Tasa | Periodo |
|---|---|---|
| Resultados (PL) | Promedio (`average`) | mes de la línea |
| Balance: activos y pasivos | Cierre (`closing`) | fecha del saldo |
| Patrimonio (3000) | Histórica (`historical`) | sin periodo |
| Moneda funcional = moneda de presentación | Identidad (1) | — |

- Solo se usan tasas `approved` del escenario de tasas de la versión (`core.budget_versions.rate_scenario`). Si hay varias versiones aprobadas de una tasa, prevalece la más reciente.
- Una tasa faltante bloquea (`MISSING_FX_RATE`). Nunca se infiere ni interpola.
- El importe en moneda de grupo se guarda con precisión completa (`numeric(24,6)`); el redondeo es solo de presentación.

## 4. Ajuste acumulado por conversión (CTA)

Por empresa y fecha de balance: `CTA = Σ activos traducidos − Σ pasivos traducidos − patrimonio a tasa histórica`. Se registra como asiento explícito `cta` en la cuenta 3900 (patrimonio).

## 5. Intercompañía

1. Se agrupan las líneas de cuentas IC por `ic_reference`.
2. Debe existir exactamente un lado vendedor (ingresos/CxC IC) y uno comprador (costos/gastos/CxP IC), con contrapartes recíprocas y el mismo periodo; si no, `IC_UNMATCHED` (crítica).
3. Se comparan en moneda de grupo. Tolerancia = `max(ic_tolerance_abs, ic_tolerance_pct × |vendedor|)` (parámetros aprobados; demo: USD 1.00 y 0.05 %).
4. Fuera de tolerancia → `IC_MISMATCH` (crítica). Solo se elimina si un usuario con `quality.approve` **acepta la diferencia**; la aceptación queda ligada a los hashes de ambas líneas y caduca si cambian.
5. Eliminación = asientos explícitos (`elimination`): `−vendedor`, `−comprador` y la diferencia `comprador − vendedor` en 8100 (resultados) o 2990 (balance). Los movimientos originales no se modifican. El impacto neto en utilidad es cero.
6. Utilidades no realizadas en inventarios: se soportan como **ajuste aprobado** (`gold.consolidation_adjustments`, tipo `unrealized_profit`); el dataset demo no incluye datos para calcularlas automáticamente (ver `pending.md`).

## 6. Métricas (versión 1, aprobadas)

| Métrica | Fórmula | Requisitos |
|---|---|---|
| Ingresos / Costos / Gastos operativos | Σ categoría (traducción + eliminaciones + ajustes) | registros de ingresos |
| EBITDA | ingresos − costos − gastos operativos | |
| EBIT | EBITDA − D&A | |
| Utilidad neta | EBIT − gasto financiero − diferencias IC − impuesto | |
| NOPAT | EBIT × (1 − `nopat_tax_rate`) | parámetro aprobado |
| Capital invertido | promedio(apertura, cierre) de deuda + patrimonio + CTA − efectivo | balance de apertura y cierre con efectivo y patrimonio |
| Capital empleado | promedio(apertura, cierre) de (efectivo + CxC + inventario + PPE) − CxP | ídem |
| ROIC | NOPAT / capital invertido promedio | |
| ROCE | EBIT / capital empleado promedio | |
| WACC | E/(D+E)·Ke + D/(D+E)·Kd·(1 − t), con E = patrimonio + CTA y D = deuda al cierre | Ke, Kd, t aprobados |
| EVA | NOPAT − capital invertido promedio × WACC | |
| Margen EBITDA / operativo | EBITDA / ingresos; EBIT / ingresos | ingresos ≠ 0 |
| Participación en ingresos | (ingresos traducidos de la empresa + eliminaciones atribuidas) / ingresos consolidados | |
| Impacto de eliminaciones IC | Σ eliminaciones sobre ingresos | |
| Efecto cambiario | Σ local_B × (tasa_B − tasa_A) sobre ingresos | versión de comparación |

Principios:
- Las métricas de grupo se **recalculan desde componentes consolidados**; nunca se promedian porcentajes entre empresas.
- Los saldos de capital se promedian por fecha (apertura/cierre), no se suman como flujos.
- Faltante ≠ cero: si falta un componente requerido, la métrica es `not_calculable` con la lista de faltantes (p. ej. la Proyección no tiene balance → ROIC, ROCE, WACC y EVA no calculables).
- Métricas por empresa o país: base **individual traducida, antes de eliminaciones** (advertencia explícita en cada respuesta).

## 7. Puente de variación (versión A → B)

Por empresa: `volumen = Σ_B local·tasa_A − Σ_A grupo` y `tipo de cambio = Σ_B local·(tasa_B − tasa_A)`; más `eliminaciones_B − eliminaciones_A`, `ajustes_B − ajustes_A` y `residual = total − suma de efectos`. Si una tasa de A no es comparable, ese importe pasa al residual con advertencia.

## 8. Escenarios

Ver fórmulas en `packages/financial-engine/src/scenarios.ts` (se muestran también en la UI). Supuestos explícitos; si se indica inversión adicional sin rendimiento operativo, el escenario queda `incomplete`. Nunca modifica la consolidación base.

## 9. Estados de consolidación

`draft → validating → (blocked | ready_for_review | failed)`, `ready_for_review → approved → published → superseded`. Aprobar exige cero incidencias abiertas críticas o advertencias sin aceptar; aprobar y publicar verifican que el hash de entradas no haya cambiado. Solo una corrida publicada por versión. Triggers en BD impiden modificar resultados de corridas aprobadas/publicadas.
