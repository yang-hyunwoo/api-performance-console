package spring_performance_test.controller;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import spring_performance_test.domain.TestRecord;
import spring_performance_test.repository.TestRecordRepository;

@Validated
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/records")
@Tag(name = "테스트 레코드", description = "PostgreSQL 기반 CRUD 성능 테스트 API")
public class TestRecordController {

    private final TestRecordRepository repository;

    @GetMapping
    @Operation(summary = "레코드 목록 조회")
    public Page<TestRecordResponse> getRecords(
            @Parameter(description = "페이지 번호")
            @RequestParam(defaultValue = "0")
            @Min(0) int page,

            @Parameter(description = "페이지 크기")
            @RequestParam(defaultValue = "10")
            @Min(1) @Max(100) int size
    ) {
        return repository.findAll(
                PageRequest.of(page, size, Sort.by("id").ascending())
        ).map(TestRecordResponse::from);
    }

    // 2. 단건 조회
    @GetMapping("/{id}")
    @Operation(summary = "레코드 단건 조회")
    public TestRecordResponse getRecord(
            @Parameter(description = "레코드 ID")
            @PathVariable Long id
    ) {
        return TestRecordResponse.from(findRecord(id));
    }

    // 3. 생성
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "레코드 생성")
    public TestRecordResponse createRecord(
            @Valid @RequestBody TestRecordRequest request
    ) {
        TestRecord record = new TestRecord(
                request.name(),
                request.category(),
                request.numericValue(),
                request.enabled()
        );

        return TestRecordResponse.from(repository.save(record));
    }

    // 4. 수정
    @PutMapping("/{id}")
    @Operation(summary = "레코드 수정")
    public TestRecordResponse updateRecord(
            @PathVariable Long id,
            @Valid @RequestBody TestRecordRequest request
    ) {
        TestRecord record = findRecord(id);

        record.update(
                request.name(),
                request.category(),
                request.numericValue(),
                request.enabled()
        );

        return TestRecordResponse.from(repository.save(record));
    }

    // 5. 삭제
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(summary = "레코드 삭제")
    public void deleteRecord(@PathVariable Long id) {
        TestRecord record = findRecord(id);
        repository.delete(record);
    }

    private TestRecord findRecord(Long id) {
        return repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND,
                        "레코드를 찾을 수 없습니다."
                ));
    }

    // 생성 및 수정 요청
    public record TestRecordRequest(
            @NotBlank
            @Schema(description = "레코드 이름", example = "TEST_RECORD_1")
            String name,

            @NotBlank
            @Schema(description = "카테고리", example = "A")
            String category,

            @NotNull
            @Schema(description = "숫자 값", example = "100")
            Integer numericValue,

            @NotNull
            @Schema(description = "활성화 여부", example = "true")
            Boolean enabled
    ) {}

    // 응답
    public record TestRecordResponse(
            Long id,
            String name,
            String category,
            Integer numericValue,
            Boolean enabled
    ) {
        public static TestRecordResponse from(TestRecord record) {
            return new TestRecordResponse(
                    record.getId(),
                    record.getName(),
                    record.getCategory(),
                    record.getNumericValue(),
                    record.getEnabled()
            );
        }
    }
}