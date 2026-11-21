"""
NEXORA AI — Generador determinista del dataset DEMO (100 % ficticio).

Produce:
  data/demo/files/<VERSION>/<COMPANY>.(csv|xlsx)   archivos presupuestarios con formatos distintos
  data/demo/manifest.json                           empresas, formatos, mapeos de columnas, errores sembrados y resoluciones
  data/demo/rates.json                              tasas de cambio (supuestos explícitos del demo)
  supabase/seeds/20_demo_group.sql                            datos maestros del grupo demo (empresas, catálogos, mapeos, tasas)

No usa aleatoriedad: todas las cifras salen de parámetros declarados abajo.
Ejecutar: python scripts/generate_demo_data.py
"""
from __future__ import annotations

import csv
import json
import uuid
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "data" / "demo"
NS = uuid.UUID("6f1d2c1e-6b7a-4c55-9b0e-6e6578307261")  # namespace fijo para UUID reproducibles


def uid(*parts: str) -> str:
    return str(uuid.uuid5(NS, "/".join(parts)))


def q2(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


D = Decimal
ORG_ID = uid("org", "ALTAVISTA")
ORG2_ID = uid("org", "BOREAL")
YEAR = 2027
MONTHS = [f"{YEAR}-{m:02d}" for m in range(1, 13)]
OPENING = f"{YEAR - 1}-12"
CLOSING = f"{YEAR}-12"
SEASON = [D(x) for x in ["0.92", "0.88", "0.97", "1.00", "1.02", "1.00", "0.98", "1.01", "1.00", "1.04", "1.06", "1.12"]]

# ---------------------------------------------------------------- catálogo corporativo
GROUP_ACCOUNTS = [
    # code, name, statement, category, normal_balance, is_ic, rate_type
    ("4000", "Ingresos por ventas", "PL", "revenue", "credit", False, "average"),
    ("4100", "Ingresos intercompañía", "PL", "revenue", "credit", True, "average"),
    ("5000", "Costo de ventas", "PL", "cogs", "debit", False, "average"),
    ("5100", "Costo intercompañía", "PL", "cogs", "debit", True, "average"),
    ("6000", "Sueldos y prestaciones", "PL", "opex", "debit", False, "average"),
    ("6100", "Arrendamientos", "PL", "opex", "debit", False, "average"),
    ("6200", "Mercadeo", "PL", "opex", "debit", False, "average"),
    ("6300", "Servicios intercompañía", "PL", "opex", "debit", True, "average"),
    ("6900", "Otros gastos operativos", "PL", "opex", "debit", False, "average"),
    ("7000", "Depreciación y amortización", "PL", "da", "debit", False, "average"),
    ("8000", "Gasto financiero", "PL", "interest", "debit", False, "average"),
    ("8100", "Diferencias de conciliación intercompañía", "PL", "other", "debit", False, "average"),
    ("9000", "Impuesto sobre la renta", "PL", "tax", "debit", False, "average"),
    ("1000", "Efectivo y equivalentes", "BS", "cash", "debit", False, "closing"),
    ("1100", "Cuentas por cobrar", "BS", "receivables", "debit", False, "closing"),
    ("1150", "Cuentas por cobrar intercompañía", "BS", "receivables", "debit", True, "closing"),
    ("1200", "Inventarios", "BS", "inventory", "debit", False, "closing"),
    ("1500", "Propiedad, planta y equipo neto", "BS", "ppe", "debit", False, "closing"),
    ("2000", "Cuentas por pagar", "BS", "payables", "credit", False, "closing"),
    ("2050", "Cuentas por pagar intercompañía", "BS", "payables", "credit", True, "closing"),
    ("2500", "Deuda financiera", "BS", "debt", "credit", False, "closing"),
    ("2990", "Diferencias de conciliación IC (balance)", "BS", "payables", "credit", False, "closing"),
    ("3000", "Patrimonio", "BS", "equity", "credit", False, "historical"),
    ("3900", "Ajuste acumulado por conversión (CTA)", "BS", "cta", "credit", False, "closing"),
]
CONSOLIDATION_ONLY = {"8100", "2990", "3900"}

# ---------------------------------------------------------------- empresas
FORMATS = {
    "GT": {
        "kind": "csv", "delimiter": ",", "decimal_separator": ".", "thousands_separator": "",
        "period_format": "YYYY-MM",
        "headers": ["Cuenta Contable", "Descripción", "Mes", "Importe", "Moneda", "Contraparte", "Referencia IC"],
    },
    "HN": {
        "kind": "csv", "delimiter": ",", "decimal_separator": ".", "thousands_separator": "",
        "period_format": "YYYYMM",
        "headers": ["codigo_cuenta", "nombre_cuenta", "periodo", "monto", "moneda", "cia_relacionada", "doc_ic"],
    },
    "SV": {
        "kind": "xlsx", "sheet": "Presupuesto", "decimal_separator": ".", "thousands_separator": "",
        "period_format": "MON-YYYY",
        "headers": ["Account", "Account Name", "Period", "Amount", "Currency", "IC Partner", "IC Ref"],
    },
    "PA": {
        "kind": "csv", "delimiter": ";", "decimal_separator": ",", "thousands_separator": ".",
        "period_format": "MM/YYYY",
        "headers": ["Cta", "Concepto", "Mes", "Valor", "Divisa", "Socio IC", "Ref IC"],
    },
}
CANONICAL = ["account_code", "account_name", "period", "amount", "currency", "counterparty_code", "ic_reference"]

COMPANIES = [
    # code, name, country, currency, format, profile
    ("ALT-ALIM", "Altavista Alimentos, S.A.", "GT", "GTQ", "GT",
     dict(rev=D("96000000"), cogs=D("0.58"), sal=D("1450000"), rent=D("310000"), mkt=D("0.035"), oth=D("180000"), da=D("420000"), int_=D("150000"),
          bs=dict(cash=(D("6800000"), D("7900000")), ar=(D("11200000"), D("12500000")), inv=(D("9400000"), D("10100000")), ppe=(D("38000000"), D("39500000")), ap=(D("7600000"), D("8200000")), debt=(D("24000000"), D("21500000"))))),
    ("ALT-LOGI", "Altavista Logística, S.A.", "GT", "GTQ", "GT",
     dict(rev=D("31000000"), cogs=D("0.52"), sal=D("720000"), rent=D("140000"), mkt=D("0.010"), oth=D("95000"), da=D("260000"), int_=D("70000"),
          bs=dict(cash=(D("2100000"), D("2600000")), ar=(D("3900000"), D("4200000")), inv=None, ppe=(D("19500000"), D("20300000")), ap=(D("2300000"), D("2500000")), debt=(D("9800000"), D("8900000"))))),
    ("ALT-COMR", "Altavista Comercial de Honduras, S. de R.L.", "HN", "HNL", "HN",
     dict(rev=D("310000000"), cogs=D("0.61"), sal=D("5100000"), rent=D("1150000"), mkt=D("0.030"), oth=D("620000"), da=D("1300000"), int_=D("520000"),
          bs=dict(cash=(D("21000000"), D("24500000")), ar=(D("38000000"), D("41500000")), inv=(D("33000000"), D("35500000")), ppe=(D("96000000"), D("99000000")), ap=(D("27000000"), D("29500000")), debt=(D("70000000"), D("64000000"))))),
    ("ALT-SERV", "Altavista Servicios Compartidos, S. de R.L.", "HN", "HNL", "HN",
     dict(rev=D("88000000"), cogs=D("0.45"), sal=D("2300000"), rent=D("420000"), mkt=D("0.015"), oth=D("260000"), da=D("380000"), int_=D("110000"),
          bs=dict(cash=(D("7400000"), D("8600000")), ar=(D("10800000"), D("11600000")), inv=None, ppe=(D("26000000"), D("26800000")), ap=(D("6100000"), D("6600000")), debt=(D("15000000"), D("13200000"))))),
    ("ALT-DIST", "Altavista Distribuidora, S.A. de C.V.", "SV", "USD", "SV",
     dict(rev=D("18500000"), cogs=D("0.66"), sal=D("210000"), rent=D("52000"), mkt=D("0.025"), oth=D("31000"), da=D("64000"), int_=D("26000"),
          bs=dict(cash=(D("1150000"), D("1320000")), ar=(D("2250000"), D("2480000")), inv=(D("2900000"), D("3150000")), ppe=(D("6400000"), D("6650000")), ap=(D("1700000"), D("1840000")), debt=(D("3900000"), D("3500000"))))),
    ("ALT-HOLD", "Altavista Holding Corp.", "PA", "USD", "PA",
     dict(rev=D("2400000"), cogs=D("0.00"), sal=D("95000"), rent=D("18000"), mkt=D("0.000"), oth=D("21000"), da=D("9000"), int_=D("41000"),
          bs=dict(cash=(D("2600000"), D("3050000")), ar=(D("380000"), D("410000")), inv=None, ppe=(D("1200000"), D("1180000")), ap=(D("210000"), D("230000")), debt=(D("6500000"), D("6100000"))))),
]
CMAP = {c[0]: c for c in COMPANIES}

# Esquemas de códigos de cuenta por empresa (estructuras contables distintas)
def company_code(fmt: str, group_code: str) -> str:
    if fmt == "GT":
        return {"4": "4-01-", "5": "5-01-", "6": "6-0", "7": "7-01-", "8": "8-01-", "9": "9-01-", "1": "1-01-", "2": "2-01-", "3": "3-01-"}[group_code[0]] + (
            group_code[1:].zfill(3) if group_code[0] != "6" else group_code[1] + "-" + group_code[2:].zfill(3))
    if fmt == "HN":
        prefix = {"4": "IV", "5": "CV", "6": "GA", "7": "DA", "8": "GF", "9": "IR", "1": "AC", "2": "PS", "3": "PT"}[group_code[0]]
        return prefix + group_code[1:]
    if fmt == "SV":
        return group_code + "0"
    if fmt == "PA":
        return {
            "4000": "REV.SALES", "4100": "REV.IC", "5000": "COS.SALES", "5100": "COS.IC", "6000": "EXP.PAYROLL", "6100": "EXP.RENT",
            "6200": "EXP.MKT", "6300": "EXP.IC", "6900": "EXP.OTHER", "7000": "EXP.DA", "8000": "EXP.FIN", "9000": "EXP.TAX",
            "1000": "BS.CASH", "1100": "BS.AR", "1150": "BS.AR.IC", "1200": "BS.INV", "1500": "BS.PPE", "2000": "BS.AP",
            "2050": "BS.AP.IC", "2500": "BS.DEBT", "3000": "BS.EQUITY",
        }[group_code]
    raise ValueError(fmt)


ACC = {a[0]: a for a in GROUP_ACCOUNTS}

# ---------------------------------------------------------------- tasas (USD por 1 unidad de moneda local) — supuestos DEMO
def avg_rates(base: str, drift: str) -> list[Decimal]:
    b, d = D(base), D(drift)
    return [q6(b + d * i) for i in range(12)]


def q6(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


RATE_SCENARIOS = {
    "PRESUPUESTO": {
        "GTQ": {"average": avg_rates("0.129000", "0.000050"), "closing": {OPENING: D("0.128500"), CLOSING: D("0.129600")}, "historical": D("0.125000")},
        "HNL": {"average": avg_rates("0.040200", "-0.000040"), "closing": {OPENING: D("0.040500"), CLOSING: D("0.039700")}, "historical": D("0.042000")},
    },
    "PRESUPUESTO-REV": {
        "GTQ": {"average": avg_rates("0.128600", "0.000030"), "closing": {OPENING: D("0.128500"), CLOSING: D("0.129000")}, "historical": D("0.125000")},
        "HNL": {"average": avg_rates("0.040000", "-0.000060"), "closing": {OPENING: D("0.040500"), CLOSING: D("0.039300")}, "historical": D("0.042000")},
    },
    "PROYECCION": {
        "GTQ": {"average": avg_rates("0.128200", "0.000020"), "closing": {OPENING: D("0.128500"), CLOSING: D("0.128600")}, "historical": D("0.125000")},
        "HNL": {"average": avg_rates("0.039800", "-0.000070"), "closing": {OPENING: D("0.040500"), CLOSING: D("0.039000")}, "historical": D("0.042000")},
    },
}
# Error sembrado nº 3: falta la tasa promedio HNL→USD de 2027-07 en el escenario PRESUPUESTO-REV.
MISSING_RATE = ("PRESUPUESTO-REV", "HNL", "average", "2027-07")
MISSING_RATE_RESOLUTION = q6(D("0.040000") + D("-0.000060") * 6)


def rate(scn: str, ccy: str, rtype: str, period: str) -> Decimal:
    if ccy == "USD":
        return D(1)
    s = RATE_SCENARIOS[scn][ccy]
    if rtype == "average":
        return s["average"][int(period[5:7]) - 1]
    if rtype == "closing":
        return s["closing"][period]
    return s["historical"]


VERSIONS = [
    # code, name, kind, rate scenario, has_bs, factors {company: (rev_factor, opex_factor)}
    ("PRES-2027-V1", "Presupuesto 2027 · Versión 1", "budget", "PRESUPUESTO", True,
     {c[0]: (D("1"), D("1")) for c in COMPANIES}),
    ("PRES-2027-V2", "Presupuesto 2027 · Versión 2 (revisión)", "budget", "PRESUPUESTO-REV", True,
     {"ALT-ALIM": (D("1.030"), D("1.000")), "ALT-LOGI": (D("1.000"), D("0.970")), "ALT-COMR": (D("0.950"), D("1.000")),
      "ALT-SERV": (D("1.020"), D("1.010")), "ALT-DIST": (D("1.000"), D("0.920")), "ALT-HOLD": (D("1.000"), D("1.000"))}),
    ("PROY-2027", "Proyección de ejecución 2027", "forecast", "PROYECCION", False,
     {"ALT-ALIM": (D("0.980"), D("1.020")), "ALT-LOGI": (D("1.015"), D("1.000")), "ALT-COMR": (D("1.040"), D("1.030")),
      "ALT-SERV": (D("0.970"), D("0.990")), "ALT-DIST": (D("1.010"), D("1.000")), "ALT-HOLD": (D("1.000"), D("1.050"))}),
]

MGMT_FEES_USD = {"ALT-ALIM": D("40000"), "ALT-COMR": D("25000"), "ALT-DIST": D("30000")}
GT1_SV1_SALES_GTQ = D("900000")


def gen_version(vcode: str, scn: str, has_bs: bool, factors: dict) -> dict[str, list[dict]]:
    rows: dict[str, list[dict]] = {c[0]: [] for c in COMPANIES}

    def add(cc: str, gcode: str, period: str, amount: Decimal, cpty: str = "", ref: str = "", currency: str | None = None):
        rows[cc].append({"group": gcode, "period": period, "amount": q2(amount), "currency": currency or CMAP[cc][3],
                         "counterparty": cpty, "ref": ref})

    ebt: dict[tuple[str, str], Decimal] = {}
    for cc, _name, _ctry, ccy, _fmt, p in COMPANIES:
        rf, of = factors[cc]
        for i, per in enumerate(MONTHS):
            rev = q2(p["rev"] / 12 * SEASON[i] * rf)
            cogs = q2(rev * p["cogs"])
            sal = q2(p["sal"] * of)
            rent = q2(p["rent"] * of)
            mkt = q2(rev * p["mkt"] * of)
            oth = q2(p["oth"] * of)
            if rev:
                add(cc, "4000", per, rev)
            if cogs:
                add(cc, "5000", per, cogs)
            add(cc, "6000", per, sal)
            add(cc, "6100", per, rent)
            if mkt:
                add(cc, "6200", per, mkt)
            add(cc, "6900", per, oth)
            add(cc, "7000", per, p["da"])
            add(cc, "8000", per, p["int_"])
            ebt[(cc, per)] = rev - cogs - sal - rent - mkt - oth - p["da"] - p["int_"]

    # Intercompañía: honorarios de gestión del holding (USD) y ventas GT1 → SV1
    for i, per in enumerate(MONTHS):
        for buyer, usd in MGMT_FEES_USD.items():
            ref = f"MF-{per}-{buyer}"
            add("ALT-HOLD", "4100", per, usd, buyer, ref)
            bccy = CMAP[buyer][3]
            local = q2(usd / rate(scn, bccy, "average", per)) if bccy != "USD" else usd
            add(buyer, "6300", per, local, "ALT-HOLD", ref)
            ebt[("ALT-HOLD", per)] += usd
            ebt[(buyer, per)] -= local
        gtq = q2(GT1_SV1_SALES_GTQ * SEASON[i] * factors["ALT-ALIM"][0])
        ref = f"VTA-{per}-ALIM-DIST"
        add("ALT-ALIM", "4100", per, gtq, "ALT-DIST", ref)
        usd = q2(gtq * rate(scn, "GTQ", "average", per))
        add("ALT-DIST", "5100", per, usd, "ALT-ALIM", ref)
        ebt[("ALT-ALIM", per)] += gtq
        ebt[("ALT-DIST", per)] -= usd

    for (cc, per), v in ebt.items():
        tax = q2(v * D("0.25")) if v > 0 else D(0)
        if tax:
            add(cc, "9000", per, tax)

    if has_bs:
        for cc, _n, _c, ccy, _f, p in COMPANIES:
            for idx, per in enumerate([OPENING, CLOSING]):
                bs = p["bs"]
                assets = D(0)
                liabs = D(0)
                for key, g in [("cash", "1000"), ("ar", "1100"), ("inv", "1200"), ("ppe", "1500")]:
                    if bs[key] is not None:
                        add(cc, g, per, bs[key][idx])
                        assets += bs[key][idx]
                for key, g in [("ap", "2000"), ("debt", "2500")]:
                    add(cc, g, per, bs[key][idx])
                    liabs += bs[key][idx]
                if cc == "ALT-ALIM" and per == CLOSING:
                    gtq = q2(GT1_SV1_SALES_GTQ * SEASON[11] * factors["ALT-ALIM"][0])
                    add(cc, "1150", per, gtq, "ALT-DIST", f"SAL-{per}-ALIM-DIST")
                    assets += gtq
                if cc == "ALT-DIST" and per == CLOSING:
                    gtq = q2(GT1_SV1_SALES_GTQ * SEASON[11] * factors["ALT-ALIM"][0])
                    usd = q2(gtq * rate(scn, "GTQ", "closing", per))
                    add(cc, "2050", per, usd, "ALT-ALIM", f"SAL-{per}-ALIM-DIST")
                    liabs += usd
                add(cc, "3000", per, assets - liabs)
    return rows


SEEDED_ERRORS = []


def seed_errors(rows: dict[str, list[dict]]) -> None:
    """Errores sembrados intencionalmente en PRES-2027-V2 (ver manifest.json)."""
    # 1. Registro duplicado — ALT-ALIM, arrendamiento 2027-03
    dup = next(r for r in rows["ALT-ALIM"] if r["group"] == "6100" and r["period"] == "2027-03")
    rows["ALT-ALIM"].insert(rows["ALT-ALIM"].index(dup) + 1, dict(dup))
    SEEDED_ERRORS.append({"id": 1, "type": "duplicate_row", "rule": "DUPLICATE_ROW", "severity": "critical", "company": "ALT-ALIM",
                          "detail": "Fila de arrendamiento 2027-03 repetida", "resolution": {"action": "exclude_line", "target": "second_occurrence"}})
    # 2. Cuenta sin homologación — ALT-LOGI 6-09-099 (existe en su catálogo pero no tiene mapeo aprobado)
    rows["ALT-LOGI"].append({"group": None, "company_code": "6-09-099", "company_name": "Gastos de representación", "period": "2027-05",
                            "amount": D("15000.00"), "currency": "GTQ", "counterparty": "", "ref": ""})
    SEEDED_ERRORS.append({"id": 2, "type": "unmapped_account", "rule": "UNMAPPED_ACCOUNT", "severity": "critical", "company": "ALT-LOGI",
                          "detail": "Cuenta 6-09-099 sin homologar", "resolution": {"action": "map_account", "company_account": "6-09-099", "group_account": "6900"}})
    # 3. Tasa faltante — se omite del escenario PRESUPUESTO-REV (ver MISSING_RATE)
    SEEDED_ERRORS.append({"id": 3, "type": "missing_fx_rate", "rule": "MISSING_FX_RATE", "severity": "critical", "company": "ALT-COMR",
                          "detail": "Falta tasa promedio HNL→USD 2027-07 (PRESUPUESTO-REV)",
                          "resolution": {"action": "add_rate", "from": "HNL", "to": "USD", "rate_type": "average", "period": "2027-07",
                                         "scenario": "PRESUPUESTO-REV", "rate": str(MISSING_RATE_RESOLUTION)}})
    # 4. Intercompañía descuadrada — ALT-DIST registra 95 % de la compra a ALT-ALIM en 2027-06
    r = next(r for r in rows["ALT-DIST"] if r["group"] == "5100" and r["period"] == "2027-06")
    r["amount"] = q2(r["amount"] * D("0.95"))
    SEEDED_ERRORS.append({"id": 4, "type": "ic_mismatch", "rule": "IC_MISMATCH", "severity": "critical", "company": "ALT-DIST",
                          "detail": "VTA-2027-06-ALIM-DIST: costo registrado 5 % menor que la venta", "resolution": {"action": "accept_ic_difference"}})
    # 5. Moneda inválida — ALT-SERV sueldos 2027-04 con moneda 'LPS'
    r = next(r for r in rows["ALT-SERV"] if r["group"] == "6000" and r["period"] == "2027-04")
    r["currency"] = "LPS"
    SEEDED_ERRORS.append({"id": 5, "type": "invalid_currency", "rule": "UNKNOWN_CURRENCY", "severity": "critical", "company": "ALT-SERV",
                          "detail": "Moneda 'LPS' no existe en el catálogo", "resolution": {"action": "correct_field", "field": "currency", "value": "HNL"}})
    # 6. Periodo incorrecto — ALT-HOLD fila con periodo 13/2027
    rows["ALT-HOLD"].append({"group": "6900", "period": "2027-13", "amount": D("5000.00"), "currency": "USD", "counterparty": "", "ref": ""})
    SEEDED_ERRORS.append({"id": 6, "type": "invalid_period", "rule": "INVALID_PERIOD", "severity": "critical", "company": "ALT-HOLD",
                          "detail": "Periodo '13/2027' no válido", "resolution": {"action": "exclude_line"}})
    # 7. Importe inconsistente — ALT-COMR ingreso 2027-09 negativo
    r = next(r for r in rows["ALT-COMR"] if r["group"] == "4000" and r["period"] == "2027-09")
    r["amount"] = -r["amount"]
    SEEDED_ERRORS.append({"id": 7, "type": "inconsistent_amount", "rule": "INCONSISTENT_SIGN", "severity": "warning", "company": "ALT-COMR",
                          "detail": "Ingreso negativo en 2027-09", "resolution": {"action": "correct_field", "field": "amount", "value": "abs"}})
    # 8. Contraparte intercompañía inexistente — ALT-COMR venta a 'ALT-CRIC'
    rows["ALT-COMR"].append({"group": "4100", "period": "2027-08", "amount": D("120000.00"), "currency": "HNL",
                            "counterparty": "ALT-CRIC", "ref": "VTA-2027-08-COMR-CRIC"})
    SEEDED_ERRORS.append({"id": 8, "type": "unknown_counterparty", "rule": "IC_COUNTERPARTY_UNKNOWN", "severity": "critical", "company": "ALT-COMR",
                          "detail": "Contraparte 'ALT-CRIC' no pertenece al grupo", "resolution": {"action": "exclude_line"}})


MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fmt_period(fmt: str, per: str) -> str:
    y, m = per[:4], per[5:7]
    if fmt == "YYYY-MM":
        return per
    if fmt == "YYYYMM":
        return y + m
    if fmt == "MM/YYYY":
        return f"{m}/{y}"
    if fmt == "MON-YYYY":
        mi = int(m)
        return f"{MON[mi - 1]}-{y}" if 1 <= mi <= 12 else f"M{m}-{y}"
    raise ValueError(fmt)


def fmt_amount(f: dict, a: Decimal) -> str:
    s = f"{a:.2f}"
    if f["decimal_separator"] == ",":
        neg = s.startswith("-")
        ip, dp = s.lstrip("-").split(".")
        groups = []
        while len(ip) > 3:
            groups.insert(0, ip[-3:])
            ip = ip[:-3]
        groups.insert(0, ip)
        s = ("-" if neg else "") + f["thousands_separator"].join(groups) + "," + dp
    return s


def write_files(vcode: str, rows: dict[str, list[dict]]) -> list[dict]:
    out = []
    vdir = FIX / "files" / vcode
    vdir.mkdir(parents=True, exist_ok=True)
    for cc, _n, _c, _ccy, fmtk, _p in COMPANIES:
        f = FORMATS[fmtk]
        table = []
        for r in rows[cc]:
            code = r.get("company_code") or company_code(fmtk, r["group"])
            name = r.get("company_name") or ACC[r["group"]][1]
            table.append([code, name, fmt_period(f["period_format"], r["period"]),
                          r["amount"], r["currency"], r["counterparty"], r["ref"]])
        if f["kind"] == "csv":
            path = vdir / f"{cc}.csv"
            with open(path, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh, delimiter=f["delimiter"], lineterminator="\n")
                w.writerow(f["headers"])
                for t in table:
                    w.writerow([t[0], t[1], t[2], fmt_amount(f, t[3]), t[4], t[5], t[6]])
        else:
            path = vdir / f"{cc}.xlsx"
            wb = Workbook()
            ws = wb.active
            ws.title = f["sheet"]
            ws.append(f["headers"])
            for t in table:
                ws.append([t[0], t[1], t[2], float(t[3]), t[4], t[5] or None, t[6] or None])
            # Fecha fija para que el archivo sea reproducible byte a byte en lo posible
            import datetime as _dt
            wb.properties.created = _dt.datetime(2026, 11, 1)
            wb.properties.modified = _dt.datetime(2026, 11, 1)
            wb.save(path)
        out.append({"company": cc, "file": str(path.relative_to(ROOT)).replace("\\", "/"), "rows": len(table)})
    return out


def sql_str(s: str | None) -> str:
    return "null" if s is None else "'" + s.replace("'", "''") + "'"


def write_seed() -> None:
    L: list[str] = ["-- GENERADO por scripts/generate_demo_data.py — no editar a mano.",
                    "-- Grupo empresarial 100 % ficticio para demostración. Tasas = supuestos explícitos del demo.", ""]
    L.append(f"insert into core.organizations (id, slug, name, presentation_currency, is_demo) values "
             f"('{ORG_ID}', 'altavista-demo', 'Grupo Altavista (DEMO)', 'USD', true), "
             f"('{ORG2_ID}', 'boreal-demo', 'Grupo Boreal (DEMO)', 'USD', true);")
    vals = []
    for cc, name, ctry, ccy, _f, _p in COMPANIES:
        vals.append(f"('{uid('company', cc)}', '{ORG_ID}', '{cc}', {sql_str(name)}, '{ctry}', '{ccy}')")
    vals.append(f"('{uid('company', 'BOR-CR1')}', '{ORG2_ID}', 'BOR-CR1', 'Boreal Industrial, S.A.', 'CR', 'USD')")
    L.append("insert into core.companies (id, organization_id, code, name, country_code, functional_currency) values\n  " + ",\n  ".join(vals) + ";")
    # periodos
    pv = []
    for org in (ORG_ID, ORG2_ID):
        for per in [OPENING] + MONTHS:
            y, m = int(per[:4]), int(per[5:7])
            pv.append(f"('{uid('period', org, per)}', '{org}', '{per}', {y}, {m}, {YEAR}, {'true' if per == OPENING else 'false'})")
    L.append("insert into core.fiscal_periods (id, organization_id, code, calendar_year, month, fiscal_year, is_opening) values\n  " + ",\n  ".join(pv) + ";")
    # versiones
    vv = []
    for vcode, vname, kind, scn, has_bs, _f in VERSIONS:
        vv.append(f"('{uid('version', vcode)}', '{ORG_ID}', '{vcode}', {sql_str(vname)}, '{kind}', {YEAR}, '{scn}', {'true' if has_bs else 'false'})")
    L.append("insert into core.budget_versions (id, organization_id, code, name, kind, fiscal_year, rate_scenario, includes_balance_sheet) values\n  " + ",\n  ".join(vv) + ";")
    # catálogo corporativo
    av = []
    for org in (ORG_ID, ORG2_ID):
        for code, name, st, cat, nb, ic, rt in GROUP_ACCOUNTS:
            av.append(f"('{uid('account', org, code)}', '{org}', '{code}', {sql_str(name)}, '{st}', '{cat}', '{nb}', {'true' if ic else 'false'}, '{rt}', {'true' if code in CONSOLIDATION_ONLY else 'false'})")
    L.append("insert into silver.accounts (id, organization_id, code, name, statement, category, normal_balance, is_intercompany, rate_type, consolidation_only) values\n  " + ",\n  ".join(av) + ";")
    # catálogos por empresa + mapeos aprobados
    ca, mp = [], []
    for cc, _n, _c, _ccy, fmtk, _p in COMPANIES:
        cid = uid("company", cc)
        for code, name, *_ in GROUP_ACCOUNTS:
            if code in CONSOLIDATION_ONLY:
                continue
            ccode = company_code(fmtk, code)
            ca.append(f"('{cid}', '{ccode}', {sql_str(name)})")
            mp.append(f"('{uid('mapping', cc, ccode)}', '{ORG_ID}', '{cid}', '{ccode}', '{uid('account', ORG_ID, code)}', 'approved')")
        if cc == "ALT-LOGI":
            ca.append(f"('{cid}', '6-09-099', 'Gastos de representación')")  # sin mapeo: error sembrado nº 2
    L.append("insert into silver.company_accounts (company_id, code, name) values\n  " + ",\n  ".join(ca) + ";")
    L.append("insert into silver.account_mappings (id, organization_id, company_id, company_account_code, account_id, status) values\n  " + ",\n  ".join(mp) + ";")
    # tasas
    rv = []
    for scn, ccys in RATE_SCENARIOS.items():
        for ccy, d in ccys.items():
            for i, per in enumerate(MONTHS):
                if (scn, ccy, "average", per) == MISSING_RATE:
                    continue
                rv.append(f"('{ORG_ID}', '{ccy}', 'USD', '{per}', 'average', '{scn}', {d['average'][i]}, 'Supuesto DEMO')")
            for per, r in d["closing"].items():
                rv.append(f"('{ORG_ID}', '{ccy}', 'USD', '{per}', 'closing', '{scn}', {r}, 'Supuesto DEMO')")
            rv.append(f"('{ORG_ID}', '{ccy}', 'USD', null, 'historical', '{scn}', {d['historical']}, 'Supuesto DEMO (aporte de capital)')")
    L.append("insert into silver.exchange_rates (organization_id, from_currency, to_currency, period_code, rate_type, scenario, rate, source) values\n  " + ",\n  ".join(rv) + ";")
    L.append("update silver.exchange_rates set status = 'approved', approved_at = now() where organization_id = '" + ORG_ID + "';")
    # parámetros financieros aprobados (supuestos DEMO)
    L.append(f"insert into core.financial_parameters (organization_id, fiscal_year, code, value, description) values "
             f"('{ORG_ID}', {YEAR}, 'nopat_tax_rate', 0.25, 'Tasa impositiva para NOPAT (supuesto DEMO)'), "
             f"('{ORG_ID}', {YEAR}, 'cost_of_equity', 0.14, 'Costo del patrimonio Ke (supuesto DEMO)'), "
             f"('{ORG_ID}', {YEAR}, 'cost_of_debt', 0.08, 'Costo de la deuda antes de impuestos Kd (supuesto DEMO)'), "
             f"('{ORG_ID}', {YEAR}, 'ic_tolerance_abs', 1.00, 'Tolerancia absoluta de conciliación IC en moneda de grupo'), "
             f"('{ORG_ID}', {YEAR}, 'ic_tolerance_pct', 0.0005, 'Tolerancia relativa de conciliación IC');")
    out = ROOT / "supabase" / "seeds" / "20_demo_group.sql"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n\n".join(L) + "\n", encoding="utf-8")


def main() -> None:
    manifest = {
        "disclaimer": "Dataset 100 % ficticio generado para demostración. No representa empresas ni cifras reales.",
        "organization": {"id": ORG_ID, "slug": "altavista-demo", "presentation_currency": "USD"},
        "second_organization": {"id": ORG2_ID, "slug": "boreal-demo"},
        "fiscal_year": YEAR,
        "companies": [{"id": uid("company", c[0]), "code": c[0], "name": c[1], "country": c[2], "currency": c[3], "format": c[4]} for c in COMPANIES],
        "column_mappings": {
            k: {"columns": dict(zip(CANONICAL, f["headers"])), **{x: f[x] for x in f if x not in ("headers",)}}
            for k, f in FORMATS.items()
        },
        "versions": [],
        "seeded_errors": [],
    }
    for vcode, vname, kind, scn, has_bs, factors in VERSIONS:
        rows = gen_version(vcode, scn, has_bs, factors)
        if vcode == "PRES-2027-V2":
            seed_errors(rows)
        files = write_files(vcode, rows)
        manifest["versions"].append({"id": uid("version", vcode), "code": vcode, "name": vname, "kind": kind, "rate_scenario": scn,
                                     "includes_balance_sheet": has_bs, "files": files,
                                     "has_seeded_errors": vcode == "PRES-2027-V2"})
    manifest["seeded_errors"] = SEEDED_ERRORS
    (FIX / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_seed()
    print("Dataset DEMO generado en", FIX)


if __name__ == "__main__":
    main()
