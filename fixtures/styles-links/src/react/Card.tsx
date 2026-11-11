import "./card.css";
import { Button } from "./Button";

export const Card = ({ open }: { open: boolean }) => (
  <section className="card">
    <h2 className={open ? "title open" : "title"}>Hi</h2>
    <Button />
    <p className={`note ${open ? "open" : ""} size-${open}`} />
  </section>
);
