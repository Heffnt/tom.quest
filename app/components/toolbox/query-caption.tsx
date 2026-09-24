// QueryCaption — principle 4: the one mono line under a figure, count or table
// naming the query it draws from, in the form
// `tts.listTodos → counts by waiting reason × source`.

export default function QueryCaption({ text }: { text: string }) {
  return <p className="tb-caption">{text}</p>;
}
