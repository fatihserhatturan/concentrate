import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

// The URL variable is reassigned by a switch: the call requests both routes.
export function useArticles(tab: string, page: number) {
  let url = `/api/articles?offset=${page}`;
  switch (tab) {
    case 'feed':
      url = `/api/articles/feed?offset=${page}`;
      break;
    case 'tag':
      url = `/api/articles?tag=${tab}`;
      break;
  }
  return useSWR(url, fetcher);
}

// The same through fetch, with an if instead of a switch.
export function loadArticles(feed: boolean) {
  let path = '/api/articles';
  if (feed) path = '/api/articles/feed';
  return fetch(path);
}

// A const holds one URL.
export function loadTags() {
  const path = '/api/tags';
  return fetch(path);
}

// `+=` builds a URL that is not known: no request is linked.
export function loadProfile(name: string) {
  let path = '/api/profiles/';
  path += name;
  return fetch(path);
}

// An assignment inside a nested function is not followed.
export function loadLater() {
  let path = '/api/tags';
  const later = () => {
    path = '/api/articles/feed';
  };
  later();
  return fetch(path);
}
