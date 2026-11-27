import { projectData } from "../project-data/instance";
import { SchemaEditor } from "../schema/SchemaEditor";
import { notify } from "../services";
import { useT } from "../solid";
import { Dialog } from "./Dialog";

/** 属性スキーマの編集画面（`core.project.schema`）。 */
export default function SchemaDialog(props: { onClose: () => void }) {
  const t = useT();
  return (
    <Dialog title={t("schema.title")} onClose={props.onClose} wide>
      <SchemaEditor
        data={projectData}
        notify={(level, text) => notify(level, text)}
      />
    </Dialog>
  );
}
