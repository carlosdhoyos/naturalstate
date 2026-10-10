import type { ChartSpec } from './build'

export interface Preset {
  label: string
  hint: string
  spec: Partial<ChartSpec>
}

/** Starting points per dataset — each one is just a ChartSpec, fully editable afterwards. */
export const PRESETS: Record<string, Preset[]> = {
  birdnet_predictions: [
    { label: 'Confidence by species', hint: 'Share of each species’ predictions per confidence bin — one panel per species', spec: { kind: 'histogram', x: 'confidence', facet: 'common_name', norm: 'percent', bins: 40 } },
    { label: 'Logit(confidence) by species', hint: 'Same, on the Wood & Kahl x-axis', spec: { kind: 'histogram', x: 'confidence', xTransform: 'logit', facet: 'common_name', norm: 'percent', bins: 40 } },
    { label: 'Confidence ECDF', hint: 'Cumulative distributions overlaid — easiest way to compare species', spec: { kind: 'ecdf', x: 'confidence', color: 'common_name' } },
    { label: 'Predictions per species', hint: 'Volume per class', spec: { kind: 'bar', x: 'common_name', agg: 'count', horizontal: true } },
    { label: 'Hour of day', hint: 'When each species is detected (recorder clock)', spec: { kind: 'bar', x: 'hour_of_day', color: 'common_name', agg: 'count', barmode: 'stack', facet: 'common_name', sharedY: false } },
    { label: 'Daily predictions', hint: 'Detections per day by species', spec: { kind: 'line', x: 'detection_time', timeUnit: 'day', color: 'common_name', agg: 'count' } },
    { label: 'Recorder × species', hint: 'Where predictions come from', spec: { kind: 'heatmap', x: 'common_name', y: 'folder', agg: 'count', topN: 60 } },
    { label: 'Validated vs not', hint: 'Are validated predictions representative?', spec: { kind: 'box', y: 'confidence', x: 'common_name', color: 'validated' } },
  ],
  validation_results: [
    { label: 'Wood & Kahl view', hint: 'Outcome vs logit(confidence) with binned precision', spec: { kind: 'scatter', x: 'confidence', xTransform: 'logit', y: 'outcome', jitterY: 0.08, color: 'outcome_label', facet: 'commonName', trend: true, bins: 8, opacity: 0.55 } },
    { label: 'Precision per confidence bin', hint: 'Mean outcome (Wilson 95% CI) per bin', spec: { kind: 'bar', x: 'confidence', y: 'outcome', agg: 'mean', facet: 'commonName', bins: 10, barmode: 'group' } },
    { label: 'Confidence by outcome', hint: 'Where correct and incorrect clips sit', spec: { kind: 'strip', y: 'confidence', x: 'commonName', color: 'outcome_label', opacity: 0.7 } },
    { label: 'Sampling of confidence', hint: 'How validation clips were drawn across scores', spec: { kind: 'histogram', x: 'confidence', color: 'commonName', barmode: 'stack', bins: 20 } },
    { label: 'Outcome per species', hint: 'Correct vs incorrect counts', spec: { kind: 'bar', x: 'commonName', color: 'outcome_label', agg: 'count', barmode: 'stack', horizontal: true } },
    { label: 'Link to predictions', hint: 'How each validated clip links to a prediction (unique / tied score / not found)', spec: { kind: 'bar', x: 'commonName', color: 'link_to_predictions', agg: 'count', barmode: 'stack', horizontal: true } },
  ],
  herbaceous_veg_survey: [
    { label: 'Survey duration', hint: 'Minutes from opening to finishing the form', spec: { kind: 'strip', y: 'duration_min', x: 'field_team_specifics-recorder_label', color: 'DeviceID' } },
    { label: 'Submission delay', hint: 'Hours from finishing to server', spec: { kind: 'histogram', x: 'submission_delay_h', color: 'DeviceID', barmode: 'stack', bins: 20 } },
    { label: 'Surveys per day', hint: 'Field effort over time', spec: { kind: 'bar', x: 'survey_begin-start_time', timeUnit: 'day', color: 'DeviceID', barmode: 'stack' } },
    { label: 'Review state', hint: 'Accepted / rejected / pending', spec: { kind: 'bar', x: 'ReviewState', color: 'DeviceID', barmode: 'stack' } },
  ],
  'herbaceous_veg_survey-quadrat_repeat': [
    { label: 'List species per quadrat', hint: 'Count of project-list species', spec: { kind: 'bar', x: 'n_list_species', color: 'herbs_present', barmode: 'stack' } },
    { label: 'Species per quadrat by plot', hint: 'Spread across plots', spec: { kind: 'box', y: 'n_list_species', x: 'plot_name', topN: 40 } },
    { label: 'Most recorded list species', hint: 'Token counts of the multi-select', spec: { kind: 'bar', x: 'list_species_names', horizontal: true, topN: 30 } },
    { label: 'GPS accuracy', hint: 'Reported accuracy of quadrat points (m)', spec: { kind: 'histogram', x: 'location_quadrat-Accuracy', bins: 20 } },
    { label: 'Herbs present by plot', hint: 'Share of quadrats with herbs', spec: { kind: 'bar', x: 'plot_name', color: 'herbs_present', agg: 'share', barmode: 'stack', topN: 40, sort: 'label' } },
  ],
  'herbaceous_veg_survey-additional_species_repeat': [
    { label: 'Entry mode', hint: 'new/reuse × unknown/missing', spec: { kind: 'bar', x: 'species_entry_mode', horizontal: true } },
    { label: 'Entry mode by plot', hint: 'Who records what', spec: { kind: 'bar', x: 'plot_name', color: 'species_entry_mode', barmode: 'stack', topN: 40, sort: 'label' } },
    { label: 'Most frequent names', hint: 'validated_name counts', spec: { kind: 'bar', x: 'validated_name', horizontal: true, topN: 30 } },
  ],
  register_vegetation_plots: [
    { label: 'Ecosystem type', hint: 'Recorded ecosystem per plot', spec: { kind: 'bar', x: 'plot_metadata-ecosystem_type_name', horizontal: true } },
    { label: 'Ground cover', hint: 'Multi-select token counts', spec: { kind: 'bar', x: 'plot_metadata-ground_cover', horizontal: true } },
    { label: 'Disturbance types', hint: 'Multi-select token counts', spec: { kind: 'bar', x: 'plot_metadata-disturbance_types', horizontal: true } },
    { label: 'Endpoint GPS accuracy', hint: 'Endpoint A accuracy (m)', spec: { kind: 'histogram', x: 'plot_metadata-collect_points-endpoint_a-location_endpoint_a-Accuracy', bins: 15 } },
  ],
  species: [
    { label: 'Families', hint: 'Species per family', spec: { kind: 'bar', x: 'family', horizontal: true, topN: 30 } },
    { label: 'Groups', hint: 'herbaceous / woody …', spec: { kind: 'bar', x: 'groups', horizontal: true } },
  ],
  species_extra: [{ label: 'Review status', hint: 'By group type', spec: { kind: 'bar', x: 'review_status', color: 'group_type', barmode: 'stack' } }],
  centroids: [{ label: 'Sample status', hint: 'Primary / backup by stratum', spec: { kind: 'bar', x: 'sample_status', color: 'stratum_label', barmode: 'stack' } }],
}
