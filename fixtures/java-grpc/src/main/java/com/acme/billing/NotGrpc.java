package com.acme.billing;

import io.grpc.stub.StreamObserver;

// `LegacyImplBase` is not imported from a generated `LegacyGrpc`: nothing here is a gRPC service.
public class NotGrpc extends LegacyImplBase {
    public void run(ChargeRequest request, StreamObserver<ChargeReply> responseObserver) {}

    static class LegacyImplBase {}
}
