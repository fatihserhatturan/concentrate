// A class with a field named http that is not an HttpClient.
export class Plain {
  private http = { get: (url: string) => url };

  load() {
    return this.http.get('/api/tags');
  }
}
