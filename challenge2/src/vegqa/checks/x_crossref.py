"""X. Cross-reference sweep: entity state compared with what the forms wrote (save_to columns)."""

from __future__ import annotations

from ..engine import rule
from ..taxonomy import slot_number
from ..load import by_key

NEW_MODES = ("new_unknown", "new_missing")


@rule("X01")
def entity_vs_form(ctx):
    d = ctx.data
    se = by_key(d.ent["species_extra"], "__id")
    q = by_key(d.quadrat, "KEY")
    s = by_key(d.survey, "KEY")
    e = d.extra[d.extra.entry_mode.isin(NEW_MODES)].copy()
    e["submitted"] = e.PARENT_KEY.map(q.PARENT_KEY).map(s._submitted)
    for slot, g in e.sort_values("submitted").groupby("target_extra_name"):
        last = g.iloc[-1]  # the entity holds the last write the server received
        num = slot_number(se.group_type.get(slot, ""), se.unknown_index.get(slot, "")) if slot in se.index else slot[:8]
        if slot not in se.index:
            ctx.add("fail", "species_extra", num, source_table="species_extra", source_key=slot, observed="written slot not in the entity list", expected="entity exists")
            continue
        ent = se.loc[slot]
        p = []
        for field, want in (("label", last.entity_label_to_write), ("review_status", last.review_status), ("new_record_reason", last.new_record_reason),
                            ("choice_status", last.write_choice_status)):
            if str(ent[field]) != str(want):
                p.append(f"{field} {ent[field]!r} != written {want!r}")
        ctx.add("fail" if p else "pass", "species_extra", num, source_table="species_extra", source_key=slot,
                observed="; ".join(p) or "entity = last write", expected="entity fields = what the last submission wrote")
    vp = by_key(d.ent["vegplots"], "plot_uuid")
    for _, r in d.registration.iterrows():
        if r.plot_uuid not in vp.index:
            continue
        v = vp.loc[r.plot_uuid]
        p = []
        for field, want in (("label", r.plot_name), ("is_viable", r.viable), ("plot_status", r.sample_status), ("stratum_label", r.stratum),
                            ("replicate", r["survey_begin-replicate"])):
            if str(v[field]) != str(want):
                p.append(f"{field} {v[field]!r} != registration {want!r}")
        if sorted(v._survey_uuids) != sorted(r._survey_uuids):
            p.append("survey_uuids differ from the registration")
        ctx.add("fail" if p else "pass", "vegplot", r.plot_name, plot_name=r.plot_name, source_table="vegplots", source_key=v["__id"],
                observed="; ".join(p) or "entity = registration", expected="vegplot fields = what the registration wrote")
    c = d.ent["centroids"]
    reps = sorted(c.replicate.unique())
    survey_reps = sorted(d.survey.replicate.unique())
    same = set(reps) == set(survey_reps)
    ctx.add("pass" if same else "fail", "project", "replicate labels", source_table="centroids", observed=f"centroids {reps}; surveys/vegplots {survey_reps}",
            expected="one replicate vocabulary", severity=None if same else "info", message="" if same else "the centroid list uses a different replicate label; joins on replicate would fail")
