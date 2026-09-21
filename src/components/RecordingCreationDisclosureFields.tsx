export type RecordingCreationDisclosure = {
  lyricsAuthorship: string;
  compositionAuthorship: string;
  vocalPerformance: string;
  productionMethod: string;
  lyricsExcerpt: string;
};

export const EMPTY_RECORDING_CREATION_DISCLOSURE: RecordingCreationDisclosure = {
  lyricsAuthorship: '',
  compositionAuthorship: '',
  vocalPerformance: '',
  productionMethod: '',
  lyricsExcerpt: ''
};

const SELECT_CLASS = 'mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white';

export default function RecordingCreationDisclosureFields({
  values,
  onChange
}: {
  values: RecordingCreationDisclosure;
  onChange: (values: RecordingCreationDisclosure) => void;
}) {
  return (
    <fieldset data-sway-creation-disclosure="true" className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
      <legend className="px-1 text-xs font-black text-white">Creation credits</legend>
      <p className="mt-1 text-[11px] leading-5 text-cyan-50/80">
        Who wrote the lyrics? Credit the person who made the words. If you wrote them, choose Human-written
        lyrics—even when a virtual voice performs them. Your private account identity is not substituted for the
        Public songwriter credit or pen name.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] text-slate-300">
          Lyrics
          <select
            required
            value={values.lyricsAuthorship}
            onChange={(event) => onChange({
              ...values,
              lyricsAuthorship: event.target.value,
              lyricsExcerpt: event.target.value === 'instrumental' ? '' : values.lyricsExcerpt
            })}
            className={SELECT_CLASS}
          >
            <option value="">Choose lyrics authorship</option>
            <option value="human">Human-written lyrics</option>
            <option value="human_ai_assisted">Human-led lyrics with generative assistance</option>
            <option value="generated">Generated lyrics</option>
            <option value="instrumental">Instrumental / no lyrics</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-300">
          Musical composition
          <select required value={values.compositionAuthorship} onChange={(event) => onChange({ ...values, compositionAuthorship: event.target.value })} className={SELECT_CLASS}>
            <option value="">Choose composition authorship</option>
            <option value="human">Human-composed music</option>
            <option value="human_ai_assisted">Human-led composition with generative assistance</option>
            <option value="generated">Generated musical composition</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-300">
          Voice or featured performance
          <select required value={values.vocalPerformance} onChange={(event) => onChange({ ...values, vocalPerformance: event.target.value })} className={SELECT_CLASS}>
            <option value="">Choose performance method</option>
            <option value="human">Human performance</option>
            <option value="virtual_original">Original virtual persona / voice</option>
            <option value="licensed_replica">Licensed replica of a real voice</option>
            <option value="mixed">Mixed human and virtual performance</option>
            <option value="instrumental">Instrumental / no vocal</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-300">
          Recording production
          <select required value={values.productionMethod} onChange={(event) => onChange({ ...values, productionMethod: event.target.value })} className={SELECT_CLASS}>
            <option value="">Choose production method</option>
            <option value="human">Human production</option>
            <option value="ai_assisted">AI-assisted production</option>
            <option value="generated">Generative production from creator direction</option>
            <option value="mixed">Mixed human and generative production</option>
          </select>
        </label>
      </div>
      <label className="mt-3 block text-[11px] text-slate-300">
        Shareable lyric excerpt <span className="text-slate-500">(optional, 500 characters)</span>
        <textarea
          value={values.lyricsExcerpt}
          onChange={(event) => onChange({ ...values, lyricsExcerpt: event.target.value })}
          maxLength={500}
          disabled={values.lyricsAuthorship === 'instrumental'}
          placeholder="A line listeners can discover and share"
          className="mt-1 min-h-20 w-full rounded-lg border border-white/10 bg-slate-950 p-3 text-xs text-white disabled:opacity-40"
        />
      </label>
      {['human_ai_assisted', 'generated'].includes(values.lyricsAuthorship)
        || ['human_ai_assisted', 'generated'].includes(values.compositionAuthorship)
        || ['virtual_original', 'licensed_replica', 'mixed'].includes(values.vocalPerformance)
        || ['ai_assisted', 'generated', 'mixed'].includes(values.productionMethod) ? (
          <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] leading-4 text-amber-100">
            Before publication, attach and independently verify the commercial-use terms for the synthetic
            performance or generative production. This does not change who wrote the lyrics.{values.vocalPerformance === 'licensed_replica'
              ? ' A replica of a real performer also requires verified performer consent.'
              : ''} The songwriter credit remains the lead authorship credit and keeps normal discovery reach.
          </p>
        ) : null}
    </fieldset>
  );
}
