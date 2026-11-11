import styles from "./Button.module.css";
import clsx from "clsx";

export function Button({ primary, busy }: { primary?: boolean; busy?: boolean }) {
  const dynamic = `btn-${primary}`;
  return (
    <button className={clsx(styles.btn, primary && styles["primary"], { loading: busy })} data-x={dynamic}>
      <span className={styles.icon} />
      <span className="legacy-btn label" />
    </button>
  );
}

export function plainClass(): string {
  return styles.unknown;
}
