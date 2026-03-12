/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import { appStore } from "./stores/app";
import "./styles/index.css";

render(
  () => (
    <I18nProvider
      locale={() => appStore.config().locale}
      setLocale={(locale: Locale) => appStore.setLocale(locale)}
    >
      <App />
    </I18nProvider>
  ),
  document.getElementById("root") as HTMLElement,
);
