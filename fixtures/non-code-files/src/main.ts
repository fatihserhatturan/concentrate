import "./styles/app.css";
import theme from "./styles/theme.scss";
import config from "./config.json";
import logo from "./assets/logo.svg";
import "./styles/missing.css";

export const logoUrl = new URL("./assets/banner.png", import.meta.url);
export const render = () => `${config.name} ${theme} ${logo}`;
