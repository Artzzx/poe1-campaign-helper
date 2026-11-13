import { formStyles } from "../../styles";
import {
  UrlRewriter,
  errorMessage,
  fetchStringOrUrl,
  getRewriteUrl,
} from "../../utility";
import { TextModal } from "../Modal";
import { PobData, processPob } from "./pob";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useState } from "react";
import { toast } from "react-toastify";

const URL_REWRITERS: UrlRewriter[] = [
  (url) => {
    const match = /pastebin\.com\/(.+)$/.exec(url);
    if (!match) return null;

    return `pastebin.com/raw/${match[1]}`;
  },
  (url) => {
    const match = /poe\.ninja\/pob\/(.+)$/.exec(url);
    if (!match) return null;

    return `poe.ninja/pob/raw/${match[1]}`;
  },
  (url) => {
    // pobb.in/<id>, pobb.in/<id>/, pobb.in/<id>?x, pobb.in/<id>/raw
    const match = /pobb\.in\/(?:pob\/)?([A-Za-z0-9_-]+)/.exec(url);
    if (!match) return null;

    return `pobb.in/${match[1]}/raw`;
  },
  (url) => {
    // Path of Building "open in PoB" links: pob://pobbin/<id>, pob://poeninja/<id>
    const match = /^pob:\/\/(pobbin|poeninja)\/([A-Za-z0-9_-]+)/i.exec(url);
    if (!match) return null;

    return match[1].toLowerCase() === "pobbin"
      ? `pobb.in/${match[2]}/raw`
      : `poe.ninja/pob/raw/${match[2]}`;
  },
  (url) => {
    const match = /youtube.com\/redirect\?.+?q=(.+?)(?:&|$)/.exec(url);
    if (!match) return null;
    const redirectUrl = decodeURIComponent(match[1]);

    return getRewriteUrl(redirectUrl, URL_REWRITERS);
  },
];

interface BuildImportFormProps {
  onSubmit: (pobData: PobData, pobCode: string) => void;
  onReset: () => void;
}

export function BuildImportForm({ onSubmit, onReset }: BuildImportFormProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <TextModal
        label="Path of Building Code"
        size="small"
        isOpen={isOpen}
        onRequestClose={() => setIsOpen(false)}
        onSubmit={(pobCodeOrUrl) =>
          toast.promise(
            async () => {
              const input = pobCodeOrUrl?.trim();
              if (!input) throw new Error("Nothing to import");

              const pobCode = (
                await fetchStringOrUrl(input, URL_REWRITERS)
              ).trim();

              const { pobData, skippedGems } = processPob(pobCode);
              onSubmit(pobData, pobCode);

              if (skippedGems.length > 0)
                toast.warn(
                  `Skipped ${
                    skippedGems.length
                  } gem(s) missing from the app's data: ${skippedGems.join(
                    ", "
                  )}`,
                  { autoClose: false }
                );
            },
            {
              pending: "Importing Build",
              success: "Import Success",
              error: {
                render: ({ data }) => `Import Failed: ${errorMessage(data)}`,
              },
            }
          )
        }
      />
      <div className={classNames(styles.buttonContainer)}>
        <button
          className={classNames(formStyles.formButton, styles.resetButton)}
          onClick={() => {
            onReset();
          }}
        >
          Reset Build
        </button>
        <button
          className={classNames(formStyles.formButton, styles.importButton)}
          onClick={() => {
            setIsOpen(true);
          }}
        >
          Import Build
        </button>
      </div>
    </>
  );
}
