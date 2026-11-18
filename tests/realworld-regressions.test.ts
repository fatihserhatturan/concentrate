import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { parseModuleDecoratorMetadata } from "../src/integrations/frameworks/js-ts/resolution/nestjs-modules.js";

// Regressions found by comparing a scan of the NestJS RealWorld example app
// (lujakob/nestjs-realworld-example-app) with a TypeScript compiler API reference.

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scan(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-realworld-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const graph = await buildCodeGraph(root, { continueOnError: false, keepCallSites: true });
  assert.equal(graph.report.failedFiles.length, 0);
  return graph;
}

function names(graph: Awaited<ReturnType<typeof scan>>, type: string): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === type)
    .map((rel) => `${byId.get(rel.from)?.properties.name}->${byId.get(rel.to)?.properties.name}`)
    .sort();
}

const entity = (name: string, body = "") => `import { Entity } from 'typeorm';\n@Entity()\nexport class ${name} {${body}}\n`;

describe("RealWorld regressions", () => {
  it("prefixes NestJS routes with app.setGlobalPrefix()", async () => {
    const graph = await scan({
      "src/main.ts": [
        "import { NestFactory } from '@nestjs/core';",
        "import { AppModule } from './app.module';",
        "async function bootstrap() {",
        "  const app = await NestFactory.create(AppModule);",
        "  app.setGlobalPrefix('api');",
        "  await app.listen(3000);",
        "}",
        "bootstrap();",
      ].join("\n"),
      "src/app.module.ts": "import { Module } from '@nestjs/common';\nimport { ArticleController } from './article.controller';\n@Module({ controllers: [ArticleController] })\nexport class AppModule {}\n",
      "src/article.controller.ts": [
        "import { Controller, Get, Delete } from '@nestjs/common';",
        "@Controller('articles')",
        "export class ArticleController {",
        "  @Get() findAll() {}",
        "  @Delete(':slug/favorite') unFavorite() {}",
        "}",
        "@Controller()",
        "export class AppController {",
        "  @Get() root() {}",
        "}",
      ].join("\n"),
    });

    const routes = graph.nodes
      .filter((node) => node.label === "Route")
      .map((node) => `${node.properties.method} ${node.properties.path} ${node.properties.fullPath}`)
      .sort();
    assert.deepEqual(routes, [
      "DELETE /articles/:slug/favorite /api/articles/:slug/favorite",
      "GET / /api",
      "GET /articles /api/articles",
    ]);
  });

  it("reads @Module imports past nested arrays such as TypeOrmModule.forFeature([...])", async () => {
    const graph = await scan({
      "src/user.module.ts": "import { Module } from '@nestjs/common';\n@Module({})\nexport class UserModule {}\n",
      "src/article.entity.ts": entity("ArticleEntity"),
      "src/comment.entity.ts": entity("Comment"),
      "src/article.service.ts": "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class ArticleService {}\n",
      "src/article.module.ts": [
        "import { Module } from '@nestjs/common';",
        "import { TypeOrmModule } from '@nestjs/typeorm';",
        "import { ArticleEntity } from './article.entity';",
        "import { Comment } from './comment.entity';",
        "import { ArticleService } from './article.service';",
        "import { UserModule } from './user.module';",
        "@Module({",
        "  imports: [TypeOrmModule.forFeature([ArticleEntity, Comment]), UserModule],",
        "  providers: [ArticleService],",
        "})",
        "export class ArticleModule {}",
      ].join("\n"),
    });

    assert.deepEqual(names(graph, "MODULE_IMPORTS"), ["ArticleModule->UserModule"]);
    assert.deepEqual(names(graph, "MODULE_PROVIDES"), ["ArticleModule->ArticleService"]);
  });

  it("parses each @Module element form", () => {
    const metadata = parseModuleDecoratorMetadata([
      "@Module({",
      "  imports: [ConfigModule.forRoot({ load: [config] }), forwardRef(() => UsersModule), ...shared, /* Legacy */ LegacyModule],",
      "  providers: [AppService, { provide: APP_GUARD, useClass: RolesGuard }, { provide: 'TOKEN', useFactory: (a) => a, inject: [Dep] }, { provide: Repo.name, useValue: new Repo() }],",
      "  controllers: [],",
      "  exports: [AppService],",
      "})",
    ].join("\n"));

    assert.deepEqual(Object.fromEntries(metadata), {
      imports: ["ConfigModule", "UsersModule", "shared", "LegacyModule"],
      providers: ["AppService", "APP_GUARD", "RolesGuard", "Repo"],
      controllers: [],
      exports: ["AppService"],
    });
  });

  it("injects constructor parameters and @Inject() properties, not typed relation fields", async () => {
    const graph = await scan({
      "src/user.entity.ts": entity("UserEntity"),
      "src/article.entity.ts": [
        "import { Entity, ManyToOne } from 'typeorm';",
        "import { UserEntity } from './user.entity';",
        "@Entity()",
        "export class ArticleEntity {",
        "  @ManyToOne(type => UserEntity)",
        "  author: UserEntity;",
        "}",
      ].join("\n"),
      "src/user.service.ts": [
        "import { Injectable } from '@nestjs/common';",
        "import { UserEntity } from './user.entity';",
        "@Injectable()",
        "export class UserService {",
        "  private cached: UserEntity;",
        "  constructor(private readonly users: UserEntity) {}",
        "}",
      ].join("\n"),
      "src/audit.service.ts": [
        "import { Inject, Injectable } from '@nestjs/common';",
        "import { UserService } from './user.service';",
        "@Injectable()",
        "export class AuditService {",
        "  @Inject() users: UserService;",
        "  @Inject('token') token: boolean;",
        "}",
      ].join("\n"),
    });

    assert.deepEqual(names(graph, "INJECTS"), ["AuditService->UserService", "UserService->UserEntity"]);
  });

  it("keeps calls made inside anonymous callbacks", async () => {
    const graph = await scan({
      "src/user.decorator.ts": [
        "import { createParamDecorator } from '@nestjs/common';",
        "import * as jwt from 'jsonwebtoken';",
        "export const User = createParamDecorator((data, ctx) => {",
        "  const req = ctx.switchToHttp().getRequest();",
        "  return jwt.verify(req.token, 'secret');",
        "});",
      ].join("\n"),
      "src/validation.pipe.ts": [
        "export class ValidationPipe {",
        "  buildError(errors) {",
        "    const result = {};",
        "    errors.forEach(el => {",
        "      Object.entries(el.constraints).forEach(constraint => { result[constraint[0]] = constraint[1]; });",
        "    });",
        "    const format = (value) => String(value);",
        "    return format(result);",
        "  }",
        "}",
      ].join("\n"),
    });

    const callsOf = (functionName: string) => {
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      return graph.relationships
        .filter((rel) => rel.type === "CALLS" && byId.get(rel.from)?.properties.name === functionName)
        .map((rel) => String(byId.get(rel.to)?.properties.expression))
        .sort();
    };

    assert.deepEqual(callsOf("<createParamDecorator:arg0>"), ["ctx.switchToHttp", "ctx.switchToHttp().getRequest", "jwt.verify"]);
    assert.deepEqual(callsOf("buildError"), ["Object.entries", "Object.entries(el.constraints).forEach", "errors.forEach", "format"]);
    assert.deepEqual(callsOf("format"), ["String"]);

    const handler = graph.nodes.find((node) => node.properties.name === "<createParamDecorator:arg0>")!;
    const passedTo = graph.relationships.find((rel) => rel.type === "PASSED_TO" && rel.from === handler.id);
    const initializer = graph.nodes.find((node): node is GraphNode => node.id === passedTo?.to);
    assert.equal(initializer?.properties.expression, "createParamDecorator");
  });

  it("propagates repeated data accesses at every line", async () => {
    const graph = await scan({
      "src/user.entity.ts": entity("UserEntity"),
      "src/article.service.ts": [
        "import { Injectable } from '@nestjs/common';",
        "import { InjectRepository } from '@nestjs/typeorm';",
        "import { Repository } from 'typeorm';",
        "import { UserEntity } from './user.entity';",
        "@Injectable()",
        "export class ArticleService {",
        "  constructor(@InjectRepository(UserEntity) private readonly userRepository: Repository<UserEntity>) {}",
        "  async findAll(query) {",
        "    const author = await this.userRepository.findOne({ username: query.author });",
        "    const favorited = await this.userRepository.findOne({ username: query.favorited });",
        "    return [author, favorited];",
        "  }",
        "}",
      ].join("\n"),
      "src/article.controller.ts": [
        "import { Controller, Get } from '@nestjs/common';",
        "import { ArticleService } from './article.service';",
        "@Controller('articles')",
        "export class ArticleController {",
        "  constructor(private readonly articleService: ArticleService) {}",
        "  @Get() async findAll(query) { return this.articleService.findAll(query); }",
        "}",
      ].join("\n"),
    });

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const accesses = (type: string) => graph.relationships
      .filter((rel) => rel.type === type)
      .map((rel) => {
        const from = byId.get(rel.from)!;
        const owner = from.label === "Route" ? `${from.properties.method} ${from.properties.fullPath}` : `${from.properties.className}.${from.properties.name}`;
        return `${owner}@${rel.properties.line}`;
      })
      .sort();

    assert.deepEqual(accesses("ACCESSES_DATA"), [
      "ArticleController.findAll@10",
      "ArticleController.findAll@9",
      "ArticleService.findAll@10",
      "ArticleService.findAll@9",
      "GET /articles@10",
      "GET /articles@9",
    ]);
  });
});
