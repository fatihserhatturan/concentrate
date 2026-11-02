import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface Article {
  slug: string;
}

@Injectable({ providedIn: 'root' })
export class ArticlesService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/articles';

  list() {
    return this.http.get<Article[]>(this.baseUrl);
  }

  get(slug: string) {
    return this.http.get<Article>(`${this.baseUrl}/${slug}`).pipe();
  }

  create(article: Article) {
    return this.http.post<Article>(this.baseUrl, { article });
  }

  update(article: Article) {
    return this.http.request('PUT', `${this.baseUrl}/${article.slug}`, { body: { article } });
  }

  remove(slug: string) {
    return this.http.delete(`/api/articles/${slug}`);
  }
}
