/**
 * Every CSV under ../Data Birds and ../Data Vegetation is discovered at build time and its
 * text is embedded in the bundle (?raw), so the built page needs no server and no fetch.
 * The source files are read in place, never copied or modified.
 */
const texts = import.meta.glob('../../../Data */**/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface Source {
  id: string
  file: string
  folder: string
  title: string
  group: string
  description: string
  challenge: Challenge
  /** Raw CSV text. */
  text: string
  order: number
}

export type Challenge = 'birds' | 'vegetation'

export const CHALLENGES: Record<Challenge, { number: number; title: string; short: string; task: string }> = {
  birds: {
    number: 1,
    title: 'Bird challenge',
    short: 'Birds',
    task: 'Turn BirdNET predictions into observations: for each species, find the confidence score above which a prediction is correct with ≥ 99% probability (Wood & Kahl 2024), label every clip, and specify how the Tech team can automate it.',
  },
  vegetation: {
    number: 2,
    title: 'Vegetation challenge',
    short: 'Vegetation',
    task: 'Clean, join and QA/QC the herbaceous vegetation survey data from ODK — flag errors, never fix them — and produce a data quality report (survey-level, plot-level, sampling effort, transect map) plus the spec for an automated QA/QC dashboard.',
  },
}

/** Sidebar groups, in display order, per challenge. */
export const GROUPS = [
  'BirdNET files',
  'Field submissions (ODK forms)',
  'Plots & sampling design',
  'Taxonomy',
  'Lookups',
  'Uploaded',
] as const

const VEG_GROUP: Record<string, string> = {
  herbaceous_veg_survey: 'Field submissions (ODK forms)',
  'herbaceous_veg_survey-quadrat_repeat': 'Field submissions (ODK forms)',
  'herbaceous_veg_survey-additional_species_repeat': 'Field submissions (ODK forms)',
  register_vegetation_plots: 'Field submissions (ODK forms)',
  centroids: 'Plots & sampling design',
  vegplots: 'Plots & sampling design',
  species: 'Taxonomy',
  species_extra: 'Taxonomy',
  species_extra_ids: 'Taxonomy',
}

const META: Record<string, { title: string; description: string; order: number }> = {
  birdnet_predictions: {
    title: 'BirdNET predictions',
    description:
      'Every 3-second segment where BirdNET scored at least 0.1 for one of the target species. One row = one segment × species.',
    order: 1,
  },
  validation_results: {
    title: 'Ornithologist validations',
    description:
      'Segments a human expert listened to. outcome = 1 when BirdNET’s label was correct, 0 when it was not.',
    order: 2,
  },
  herbaceous_veg_survey: {
    title: 'Herbaceous surveys',
    description: 'One row per herbaceous survey submission (a team visiting a plot and recording 20 quadrats).',
    order: 1,
  },
  'herbaceous_veg_survey-quadrat_repeat': {
    title: 'Quadrats',
    description: 'One row per quadrat. PARENT_KEY → survey KEY. Species from the project list are space-separated uuids.',
    order: 2,
  },
  'herbaceous_veg_survey-additional_species_repeat': {
    title: 'Additional species',
    description:
      'Species not on the project list: new/re-used unknowns and “missing” named species. PARENT_KEY → quadrat KEY.',
    order: 3,
  },
  register_vegetation_plots: {
    title: 'Plot registrations',
    description: 'One row per plot registration: transect endpoints A and B, midpoint, habitat and disturbance metadata.',
    order: 4,
  },
  centroids: { title: 'Centroids', description: 'Prescribed plot points (primary + backup) from the sampling design.', order: 1 },
  vegplots: { title: 'Veg plots', description: 'Registered plots, as written to the entity list by the registration form.', order: 2 },
  species: { title: 'Species list', description: 'Project species list (GBIF-backed taxonomy).', order: 3 },
  species_extra: { title: 'Species extra', description: 'Provisional taxa created in the field (unknowns and missing species).', order: 4 },
  species_extra_ids: {
    title: 'Species extra IDs',
    description: 'Curated resolution of provisional taxa (herb_NNN → species name), with reviewer notes.',
    order: 5,
  },
  project_team: { title: 'Project team', description: 'Field team members.', order: 6 },
  surveys: { title: 'Surveys', description: 'Survey definitions (project | area | target group | method).', order: 7 },
  ecosystem_types: { title: 'Ecosystem types', description: 'Lookup.', order: 8 },
  transport: { title: 'Transport', description: 'Lookup.', order: 9 },
  areas: { title: 'Areas', description: 'Lookup.', order: 10 },
  projects: { title: 'Projects', description: 'Lookup.', order: 11 },
}

function groupFor(path: string, id: string): string {
  if (path.includes('/Data Birds/')) return 'BirdNET files'
  return VEG_GROUP[id] ?? 'Lookups'
}

export const SOURCES: Source[] = Object.entries(texts)
  .map(([path, text]) => {
    const parts = path.split('/')
    const file = parts[parts.length - 1]
    const id = file.replace(/\.csv$/i, '')
    const meta = META[id]
    return {
      id,
      file,
      folder: parts.slice(3, -1).join('/'),
      title: meta?.title ?? id,
      group: groupFor(path, id),
      challenge: (path.includes('/Data Birds/') ? 'birds' : 'vegetation') as Challenge,
      description: meta?.description ?? '',
      text,
      order: meta?.order ?? 99,
    }
  })
  .sort((a, b) => GROUPS.indexOf(a.group as never) - GROUPS.indexOf(b.group as never) || a.order - b.order)
