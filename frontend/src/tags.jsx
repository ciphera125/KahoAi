// Every tag in the organization, loaded once and shared, so a tag made on the
// Tags page or from inside a contact's editor shows up everywhere else without
// a manual reload: the Tags page, the Contacts tag picker, and anywhere else
// that lists or assigns tags.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get } from "./api.js";

const TagsCtx = createContext({ tags: [], reload: () => {} });
export const useTags = () => useContext(TagsCtx);

export function TagsProvider({ children }) {
  const [tags, setTags] = useState([]);
  const reload = useCallback(() => get("/api/tags").then(setTags).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);
  return <TagsCtx.Provider value={{ tags, reload }}>{children}</TagsCtx.Provider>;
}
