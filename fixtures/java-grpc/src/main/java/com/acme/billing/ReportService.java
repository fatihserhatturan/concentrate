package com.acme.billing;

import com.acme.report.v1.ReportGrpc.ReportImplBase;
import io.grpc.stub.StreamObserver;

public class ReportService extends ReportImplBase {
    @Override
    public void generate(ReportRequest request, StreamObserver<ReportReply> responseObserver) {
        responseObserver.onCompleted();
    }
}
